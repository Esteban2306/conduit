import { Logger } from '@nestjs/common';
import { ZonedClock } from '../utils/zoned-clock';

/** Zona en la que se interpretan el horario activo y el corte del día. */
export const DEFAULT_ACTIVE_HOURS_TIMEZONE = 'America/Bogota';

export enum WarmupLevel {
  FRESH = 'FRESH',
  NORMAL = 'NORMAL',
  TRUSTED = 'TRUSTED',
}

/**
 * Límites por nivel de calentamiento. Los `maxPerHour`/`maxPerDay`, pausas
 * y ráfagas aplican solo al carril de campaña (mensajes que inicia el
 * negocio). `conversationMaxPerHour` es un techo de seguridad para las
 * respuestas a clientes que escribieron: no debería alcanzarse en uso
 * normal, existe para cortar un bucle desbocado.
 */
const WARMUP_CONFIG = {
  [WarmupLevel.FRESH]: {
    maxPerHour: 6,
    maxPerDay: 40,
    delayMultiplier: 2.5,
    breakEveryMin: 3,
    breakEveryMax: 6,
    burstChance: 0,
    conversationMaxPerHour: 60,
  },
  [WarmupLevel.NORMAL]: {
    maxPerHour: 18,
    maxPerDay: 180,
    delayMultiplier: 1.0,
    breakEveryMin: 8,
    breakEveryMax: 15,
    burstChance: 0.12,
    conversationMaxPerHour: 120,
  },
  [WarmupLevel.TRUSTED]: {
    maxPerHour: 25,
    maxPerDay: 280,
    delayMultiplier: 0.75,
    breakEveryMin: 10,
    breakEveryMax: 20,
    burstChance: 0.18,
    conversationMaxPerHour: 180,
  },
};

interface FailureResult {
  success: false;
  retryable?: boolean;
  error?: string;
}

export enum JobPriority {
  CONVERSATION = 0,
  CAMPAIGN = 10,
}

type Lane = 'conversation' | 'campaign';

interface QueuedJob {
  execute: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  enqueuedAt: number;
  attempts: number;
  maxAttempts: number;
  retryable: boolean;
  lane: Lane;
}

interface Wait {
  ms: number;
  reason: string;
}

/**
 * Rate limiter anti-ban de WhatsApp, con estado aislado por conexión.
 * Instanciado y gestionado exclusivamente por BaileysRateLimiterRegistry.
 *
 * Dos carriles, un único emisor (nunca dos envíos simultáneos por conexión):
 *
 * - Conversación: respuestas a quien escribió. Salen en orden de llegada,
 *   a cualquier hora y sin pausas largas, con una separación humana entre
 *   envíos que crece con el nivel de riesgo. Tienen prioridad.
 * - Campaña: mensajes que inicia el negocio (recordatorios, avisos). Siguen
 *   las reglas anti-ban completas: horario activo, topes por hora y día,
 *   pausas de sesión y retrasos aleatorios largos.
 *
 * Las esperas de campaña (que pueden durar horas) se interrumpen cuando
 * llega una respuesta de conversación, para que ninguna clienta quede
 * esperando detrás de un recordatorio programado.
 */
export class BaileysRateLimiter {
  private readonly logger: Logger;

  private readonly conversationQueue: QueuedJob[] = [];
  private readonly campaignQueue: QueuedJob[] = [];
  private processing = false;
  private wake: (() => void) | null = null;
  private lastWaitLog: string | null = null;

  private readonly ACTIVE_HOUR_START = 8;
  private readonly ACTIVE_HOUR_END = 21;

  private readonly DELAY_TIERS = [
    { min: 4000, max: 9000, weight: 50 },
    { min: 9000, max: 20000, weight: 30 },
    { min: 20000, max: 45000, weight: 12 },
    { min: 45000, max: 180000, weight: 6 },
    { min: 180000, max: 420000, weight: 2 },
  ];

  /** Separación mínima entre dos envíos cualesquiera de la conexión. */
  private readonly GLOBAL_GAP_MS = 3000;
  private readonly CONVERSATION_GAP_MIN_MS = 1500;
  private readonly CONVERSATION_GAP_MAX_MS = 4000;
  private readonly CONVERSATION_RECONNECT_GAP_MIN_MS = 8000;
  private readonly CONVERSATION_RECONNECT_GAP_MAX_MS = 15000;

  private sentTimestamps: number[] = [];
  private conversationTimestamps: number[] = [];
  private dailySentCount = 0;
  private lastDayRest: string;
  private readonly clock: ZonedClock;

  private lastSendAt = 0;
  private nextConversationAt = 0;
  private nextCampaignAt = 0;
  private safeModeUntil: number | null = null;

  private lastDisconnectReportedAt = 0;
  private readonly DISCONNECT_DEBOUNCE_MS = 3000;

  private messagesSinceBreak = 0;
  private nextBreakAt: number;
  private readonly BREAK_DURATION_MIN = 120000;
  private readonly BREAK_DURATION_MAX = 600000;

  private warmupLevel: WarmupLevel;

  private riskLevel = 1;
  private readonly MAX_RISK_LEVEL = 5;
  private recentFailures = 0;
  private recentDisconnects = 0;
  private readonly FAILURE_THRESHOLD = 3;
  private readonly DISCONNECT_THRESHOLD = 2;
  private lastRiskReset = Date.now();
  private readonly RISK_RESET_INTERVAL = 3600000;

  private reconnectThrottleUntil: number | null = null;
  private readonly RECONNECT_THROTTLE_MS = 60000;

  constructor(
    private readonly connectionId: string,
    initialLevel: WarmupLevel = WarmupLevel.NORMAL,
    timeZone: string = DEFAULT_ACTIVE_HOURS_TIMEZONE,
  ) {
    this.logger = new Logger(`BaileysRateLimiter:${connectionId.slice(0, 8)}`);
    this.clock = new ZonedClock(timeZone);
    this.lastDayRest = this.clock.at().dateKey;
    this.warmupLevel = initialLevel;
    const config = WARMUP_CONFIG[initialLevel];
    this.nextBreakAt = this.randomInt(
      config.breakEveryMin,
      config.breakEveryMax,
    );
  }

  async enqueue<T>(
    execute: () => Promise<T>,
    options: {
      retryable?: boolean;
      maxAttempts?: number;
      priority?: JobPriority;
    } = {},
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const lane: Lane =
        options.priority === JobPriority.CONVERSATION
          ? 'conversation'
          : 'campaign';

      const job: QueuedJob = {
        execute: execute as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
        enqueuedAt: Date.now(),
        attempts: 0,
        maxAttempts: options.maxAttempts ?? 3,
        retryable: options.retryable ?? true,
        lane,
      };

      this.laneQueue(lane).push(job);

      if (lane === 'conversation') this.wake?.();
      void this.process();
    });
  }

  enterReconnectThrottle(): void {
    this.reconnectThrottleUntil = Date.now() + this.RECONNECT_THROTTLE_MS;
    this.logger.warn('Modo throttle post-reconexión activado por 60 segundos');
  }

  reportDisconnect(): void {
    const now = Date.now();

    if (now - this.lastDisconnectReportedAt < this.DISCONNECT_DEBOUNCE_MS) {
      return;
    }
    this.lastDisconnectReportedAt = now;

    this.recentDisconnects++;
    this.logger.warn(
      `Desconexión reportada. Total recientes: ${this.recentDisconnects}`,
    );

    if (this.recentDisconnects >= this.DISCONNECT_THRESHOLD) {
      this.escalateRisk('múltiples desconexiones');
    }
  }

  setWarmupLevel(level: WarmupLevel): void {
    this.warmupLevel = level;
    const config = WARMUP_CONFIG[level];
    this.nextBreakAt = this.randomInt(
      config.breakEveryMin,
      config.breakEveryMax,
    );
    this.logger.log(`Warmup level configurado: ${level}`);
  }

  getWarmupLevel(): WarmupLevel {
    return this.warmupLevel;
  }

  getRiskLevel(): number {
    return this.riskLevel;
  }

  getQueueSize(): number {
    return this.conversationQueue.length + this.campaignQueue.length;
  }

  getLaneSizes(): { conversation: number; campaign: number } {
    return {
      conversation: this.conversationQueue.length,
      campaign: this.campaignQueue.length,
    };
  }

  tick(): void {
    this.resetDailyCountIfNeeded();
    this.tryResetRisk();
  }

  private laneQueue(lane: Lane): QueuedJob[] {
    return lane === 'conversation'
      ? this.conversationQueue
      : this.campaignQueue;
  }

  private async process(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    try {
      while (this.getQueueSize() > 0) {
        this.resetDailyCountIfNeeded();
        this.tryResetRisk();

        const lane: Lane =
          this.conversationQueue.length > 0 ? 'conversation' : 'campaign';
        const wait =
          lane === 'conversation'
            ? this.conversationWait()
            : this.campaignWait();

        if (wait.ms > 0) {
          this.logWait(lane, wait);
          // Las esperas de conversación son de segundos; las de campaña
          // pueden durar horas y se cortan si entra una conversación.
          if (lane === 'conversation') await this.sleep(wait.ms);
          else await this.interruptibleSleep(wait.ms);
          continue;
        }

        const job = this.laneQueue(lane).shift();
        if (!job) continue;

        this.lastWaitLog = null;
        await this.executeJob(job);
      }
    } finally {
      this.processing = false;
    }
  }

  private conversationWait(): Wait {
    const now = Date.now();
    const config = WARMUP_CONFIG[this.warmupLevel];

    const oneHourAgo = now - 3600000;
    this.conversationTimestamps = this.conversationTimestamps.filter(
      (t) => t > oneHourAgo,
    );
    if (this.conversationTimestamps.length >= config.conversationMaxPerHour) {
      const oldest = Math.min(...this.conversationTimestamps);
      return {
        ms: oldest + 3600000 - now + 1000,
        reason: `techo de seguridad de conversación (${config.conversationMaxPerHour}/h)`,
      };
    }

    const notBefore = Math.max(this.nextConversationAt, this.globalGapEnd());
    return { ms: Math.max(0, notBefore - now), reason: 'separación natural' };
  }

  private campaignWait(): Wait {
    const now = Date.now();
    const config = WARMUP_CONFIG[this.warmupLevel];

    const untilActive = this.getTimeUntilActiveHour();
    if (untilActive > 0) {
      return { ms: untilActive, reason: 'fuera de horario activo' };
    }

    if (this.riskLevel >= 4) {
      if (this.safeModeUntil === null || now >= this.safeModeUntil) {
        this.safeModeUntil = now + 15 * 60 * 1000 * (this.riskLevel - 2);
      }
      return {
        ms: this.safeModeUntil - now,
        reason: `modo seguro (riesgo ${this.riskLevel}/${this.MAX_RISK_LEVEL})`,
      };
    }
    this.safeModeUntil = null;

    if (this.dailySentCount >= config.maxPerDay) {
      return {
        ms: this.getWaitUntilTomorrow(),
        reason: `tope diario (${config.maxPerDay}, nivel ${this.warmupLevel})`,
      };
    }

    if (this.isRateLimited()) {
      return {
        ms: this.getTimeUntilRateLimitReset(),
        reason: `tope por hora (${config.maxPerHour})`,
      };
    }

    const notBefore = Math.max(this.nextCampaignAt, this.globalGapEnd());
    return {
      ms: Math.max(0, notBefore - now),
      reason: 'retraso entre mensajes de campaña',
    };
  }

  private globalGapEnd(): number {
    return this.lastSendAt + this.GLOBAL_GAP_MS;
  }

  private logWait(lane: Lane, wait: Wait): void {
    const key = `${lane}:${wait.reason}`;
    if (key === this.lastWaitLog) return;
    this.lastWaitLog = key;

    const seconds = Math.round(wait.ms / 1000);
    const message = `[${lane}] esperando ${seconds >= 120 ? `${Math.round(seconds / 60)} min` : `${seconds}s`}: ${wait.reason}`;
    if (wait.ms >= 60000) this.logger.log(message);
    else this.logger.debug(message);
  }

  private async executeJob(job: QueuedJob): Promise<void> {
    job.attempts++;

    let result: unknown;
    try {
      result = await job.execute();
    } catch (error) {
      this.handleFailure(job, { retryable: job.retryable, rejectWith: error });
      return;
    }

    if (this.isFailureResult(result)) {
      this.handleFailure(job, {
        retryable: job.retryable && result.retryable !== false,
        resolveWith: result,
      });
      return;
    }

    this.recordSent(job.lane);
    this.onSuccessfulSend();
    job.resolve(result);
  }

  private isFailureResult(value: unknown): value is FailureResult {
    return (
      !!value &&
      typeof value === 'object' &&
      (value as Record<string, unknown>).success === false
    );
  }

  private handleFailure(
    job: QueuedJob,
    opts: { retryable: boolean; rejectWith?: unknown; resolveWith?: unknown },
  ): void {
    this.recentFailures++;
    this.logger.warn(`Fallo en job. Fallos recientes: ${this.recentFailures}`);

    if (this.recentFailures >= this.FAILURE_THRESHOLD) {
      this.escalateRisk('múltiples fallos de envío');
    }

    const canRetry = opts.retryable && job.attempts < job.maxAttempts;

    if (canRetry) {
      this.logger.warn(
        `Job falló (intento ${job.attempts}/${job.maxAttempts}). Reencolar al final.`,
      );
      this.laneQueue(job.lane).push(job);
      return;
    }

    if ('resolveWith' in opts) {
      job.resolve(opts.resolveWith);
    } else {
      this.logger.error(`Job descartado tras ${job.attempts} intento(s).`);
      job.reject(opts.rejectWith);
    }
  }

  /** Retraso tras un mensaje de campaña (o pausa de sesión). */
  private calculateCampaignDelay(): number {
    const config = WARMUP_CONFIG[this.warmupLevel];

    if (this.isInReconnectThrottle()) {
      return this.randomInt(15000, 30000);
    }

    if (this.riskLevel === 1 && Math.random() < config.burstChance) {
      return this.randomInt(1000, 3000);
    }

    const roll = Math.random() * 100;
    let accumulated = 0;
    let baseDelay = this.randomInt(4000, 9000);

    for (const tier of this.DELAY_TIERS) {
      accumulated += tier.weight;
      if (roll <= accumulated) {
        baseDelay = this.randomInt(tier.min, tier.max);
        break;
      }
    }

    const withWarmup = baseDelay * config.delayMultiplier;
    const riskMultiplier = Math.pow(1.5, this.riskLevel - 1);
    const jitter = 0.85 + Math.random() * 0.3;

    return Math.floor(withWarmup * riskMultiplier * jitter);
  }

  /** Separación tras una respuesta de conversación. */
  private calculateConversationGap(): number {
    const base = this.isInReconnectThrottle()
      ? this.randomInt(
          this.CONVERSATION_RECONNECT_GAP_MIN_MS,
          this.CONVERSATION_RECONNECT_GAP_MAX_MS,
        )
      : this.randomInt(
          this.CONVERSATION_GAP_MIN_MS,
          this.CONVERSATION_GAP_MAX_MS,
        );
    return Math.floor(base * Math.pow(1.25, this.riskLevel - 1));
  }

  private isInReconnectThrottle(): boolean {
    return (
      this.reconnectThrottleUntil !== null &&
      Date.now() < this.reconnectThrottleUntil
    );
  }

  private escalateRisk(reason: string): void {
    if (this.riskLevel < this.MAX_RISK_LEVEL) {
      this.riskLevel++;
      this.recentFailures = 0;
      this.recentDisconnects = 0;
      this.logger.warn(
        `Riesgo escalado a ${this.riskLevel}/${this.MAX_RISK_LEVEL} por: ${reason}`,
      );
    }
  }

  private onSuccessfulSend(): void {
    const totalToday = this.dailySentCount + this.conversationTimestamps.length;
    if (totalToday > 0 && totalToday % 10 === 0 && this.riskLevel > 1) {
      this.riskLevel--;
      this.logger.log(
        `Riesgo reducido a ${this.riskLevel}/${this.MAX_RISK_LEVEL} por envíos exitosos`,
      );
    }
  }

  private tryResetRisk(): void {
    const now = Date.now();
    if (now - this.lastRiskReset > this.RISK_RESET_INTERVAL) {
      this.recentFailures = 0;
      this.recentDisconnects = 0;
      this.lastDisconnectReportedAt = 0;
      this.lastRiskReset = now;

      if (this.riskLevel > 1) {
        this.riskLevel = Math.max(1, this.riskLevel - 1);
        this.logger.log(
          `Riesgo reducido pasivamente a ${this.riskLevel}/${this.MAX_RISK_LEVEL}`,
        );
      }
    }
  }

  private isRateLimited(): boolean {
    const config = WARMUP_CONFIG[this.warmupLevel];
    const oneHourAgo = Date.now() - 3600000;
    this.sentTimestamps = this.sentTimestamps.filter((t) => t > oneHourAgo);
    return this.sentTimestamps.length >= config.maxPerHour;
  }

  private getTimeUntilRateLimitReset(): number {
    if (this.sentTimestamps.length === 0) return 0;
    const oldest = Math.min(...this.sentTimestamps);
    return oldest + 3600000 - Date.now() + 1000;
  }

  private getTimeUntilActiveHour(): number {
    const { hour } = this.clock.at();
    if (hour >= this.ACTIVE_HOUR_START && hour < this.ACTIVE_HOUR_END) return 0;

    return this.clock.msUntilHour(this.ACTIVE_HOUR_START);
  }

  private getWaitUntilTomorrow(): number {
    const { hour } = this.clock.at();
    return this.clock.msUntilHour(this.ACTIVE_HOUR_START, new Date(), {
      skipToday: hour >= this.ACTIVE_HOUR_START,
    });
  }

  private resetDailyCountIfNeeded(): void {
    const today = this.clock.at().dateKey;
    if (today !== this.lastDayRest) {
      this.dailySentCount = 0;
      this.recentFailures = 0;
      this.recentDisconnects = 0;
      this.lastDisconnectReportedAt = 0;
      this.lastDayRest = today;

      if (this.riskLevel > 2) {
        this.riskLevel = 2;
        this.logger.log(
          `Riesgo reseteado al amanecer: ${this.riskLevel}/${this.MAX_RISK_LEVEL}`,
        );
      }
      this.logger.log('Contadores diarios reseteados');
    }
  }

  private recordSent(lane: Lane): void {
    const now = Date.now();
    this.lastSendAt = now;

    if (lane === 'conversation') {
      this.conversationTimestamps.push(now);
      this.nextConversationAt = now + this.calculateConversationGap();
      return;
    }

    this.sentTimestamps.push(now);
    this.dailySentCount++;
    this.messagesSinceBreak++;

    const config = WARMUP_CONFIG[this.warmupLevel];
    if (this.messagesSinceBreak >= this.nextBreakAt) {
      const breakTime = this.randomInt(
        this.BREAK_DURATION_MIN,
        this.BREAK_DURATION_MAX,
      );
      this.logger.log(
        `Pausa de sesión de campaña: ${Math.round(breakTime / 60000)} min`,
      );
      this.nextCampaignAt = now + breakTime;
      this.messagesSinceBreak = 0;
      this.nextBreakAt = this.randomInt(
        config.breakEveryMin,
        config.breakEveryMax,
      );
    } else {
      this.nextCampaignAt = now + this.calculateCampaignDelay();
    }
  }

  private randomInt(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  /** Espera que termina antes si `wake()` se invoca (llegó una conversación). */
  private interruptibleSleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        if (this.wake === done) this.wake = null;
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.wake = done;
    });
  }
}
