import { Injectable, Logger } from '@nestjs/common';

export enum WarmupLevel {
  FRESH = 'FRESH',
  NORMAL = 'NORMAL',
  TRUSTED = 'TRUSTED',
}

const WARMUP_CONFIG = {
  [WarmupLevel.FRESH]: {
    maxPerHour: 6,
    maxPerDay: 40,
    delayMultiplier: 2.5,
    breakEveryMin: 3,
    breakEveryMax: 6,
    burstChance: 0,
  },
  [WarmupLevel.NORMAL]: {
    maxPerHour: 18,
    maxPerDay: 180,
    delayMultiplier: 1.0,
    breakEveryMin: 8,
    breakEveryMax: 15,
    burstChance: 0.12,
  },
  [WarmupLevel.TRUSTED]: {
    maxPerHour: 25,
    maxPerDay: 280,
    delayMultiplier: 0.75,
    breakEveryMin: 10,
    breakEveryMax: 20,
    burstChance: 0.18,
  },
};

interface QueuedJob {
  execute: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  enqueuedAt: number;
  attempts: number;
  maxAttempts: number;
  retryable: boolean;
}

@Injectable()
export class BaileysRateLimiter {
  private readonly logger = new Logger(BaileysRateLimiter.name);

  private queue: QueuedJob[] = [];

  private processing = false;

  private readonly ACTIVE_HOUR_START = 8;
  private readonly ACTIVE_HOUR_END = 21;

  private readonly DELAY_TIERS = [
    { min: 4000, max: 9000, weight: 50 },
    { min: 9000, max: 20000, weight: 30 },
    { min: 20000, max: 45000, weight: 12 },
    { min: 45000, max: 180000, weight: 6 },
    { min: 180000, max: 420000, weight: 2 },
  ];

  private readonly BURST_CHANCE = 0.12;

  private readonly MAX_PER_HOUR = 18;
  private readonly MAX_PER_DAY = 180;

  private sentTimestamps: number[] = [];
  private dailySentCount = 0;
  private lastDayRest = new Date().toDateString();
  private readonly MAX_MESSAGES_PER_HOUR = 25;

  private messagesSinceBreak = 0;
  private readonly BREAK_EVERY_MIN = 8;
  private readonly BREAK_EVERY_MAX = 15;
  private nextBreakAt = this.randomInt(8, 15);
  private readonly BREAK_DURATION_MIN = 120000;
  private readonly BREAK_DURATION_MAX = 600000;

  private warmupLevel: WarmupLevel = WarmupLevel.NORMAL;

  private riskLevel = 1;
  private readonly MAX_RISK_LEVEL = 5;
  private recentFailures = 0;
  private recentDisconnects = 0;
  private readonly FAILURE_THRESHOLD = 3;
  private readonly DISCONNECT_THRESHOLD = 2;
  private lastRiskReset = Date.now();
  private readonly RISK_RESET_INTERVAL = 3600000;

  async enqueue<T>(
    execute: () => Promise<T>,
    options: { retryable?: boolean; maxAttempts?: number } = {},
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push({
        execute: execute as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
        enqueuedAt: Date.now(),
        attempts: 0,
        maxAttempts: options.maxAttempts ?? 3,
        retryable: options.retryable ?? true,
      });

      this.process();
    });
  }

  reportDisconnect(): void {
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

  getRiskLevel(): number {
    return this.riskLevel;
  }

  getQueueSize(): number {
    return this.queue.length;
  }

  private async process() {
    if (this.processing) return;

    this.processing = true;

    while (this.queue.length > 0) {
      const config = WARMUP_CONFIG[this.warmupLevel];

      const waitTime = this.getTimeUntilActiveHour();

      if (waitTime > 0) {
        this.logger.log(
          `Fuera de horario activo. Esperando ${Math.round(waitTime / 60000)} minutos para reintentar...`,
        );
        await this.sleep(waitTime);
      }

      this.resetDailyCountIfNeeded();

      this.tryResetRisk();

      if (this.riskLevel >= 4) {
        const safeWait = 15 * 60 * 1000 * (this.riskLevel - 2);
        this.logger.warn(
          `Modo seguro activo (riesgo ${this.riskLevel}/${this.MAX_RISK_LEVEL}). Pausando ${Math.round(safeWait / 60000)} min`,
        );
        await this.sleep(safeWait);
        continue;
      }

      if (this.dailySentCount >= this.MAX_PER_DAY) {
        const waitTomorrow = this.getWaitUntilTomorrow();
        this.logger.warn(
          `Tope diario alcanzado (${this.MAX_PER_DAY} mensajes). Esperando ${Math.round(waitTomorrow / 3600000)} horas para reintentar...`,
        );
        await this.sleep(waitTomorrow);
        continue;
      }

      if (this.isRateLimited()) {
        const waitMs = this.getTimeUntilRateLimitReset();

        this.logger.log(
          `Límite de tasa alcanzado. Esperando ${Math.round(waitMs / 1000)} segundos para reintentar...`,
        );
        await this.sleep(waitMs);
        continue;
      }

      if (this.messagesSinceBreak >= this.nextBreakAt) {
        const breakTime = this.randomInt(
          this.BREAK_DURATION_MIN,
          this.BREAK_DURATION_MAX,
        );
        this.logger.log(
          `Pausa de sesión: ${Math.round(breakTime / 60000)} min`,
        );
        await this.sleep(breakTime);
        this.messagesSinceBreak = 0;
        this.nextBreakAt = this.randomInt(
          config.breakEveryMin,
          config.breakEveryMax,
        );
      }

      if (this.messagesSinceBreak >= this.nextBreakAt) {
        const breakTime = this.randomInt(
          this.BREAK_DURATION_MIN,
          this.BREAK_DURATION_MAX,
        );
        this.logger.log(
          `Pausa de sesión: ${Math.round(breakTime / 60000)} min`,
        );
        await this.sleep(breakTime);
        this.messagesSinceBreak = 0;
        this.nextBreakAt = this.randomInt(
          this.BREAK_EVERY_MIN,
          this.BREAK_EVERY_MAX,
        );
      }

      const job = this.queue.shift();
      if (!job) break;

      try {
        await this.executeJob(job);
      } catch (error) {
        job.reject(error);
      }

      if (this.queue.length > 0) {
        const delay = this.calculateDelay();
        this.logger.debug(
          `Esperando ${Math.round(delay / 1000)}s antes de procesar el siguiente mensaje...`,
        );
        await this.sleep(delay);
      }
    }
    this.processing = false;
  }

  private async executeJob(job: QueuedJob): Promise<void> {
    job.attempts++;

    try {
      const result = await job.execute();
      this.recordSent();
      this.onSuccessfulSend();
      job.resolve(result);
    } catch (error) {
      this.recentFailures++;
      this.logger.warn(
        `Fallo en job. Fallos recientes: ${this.recentFailures}`,
      );

      if (this.recentFailures >= this.FAILURE_THRESHOLD) {
        this.escalateRisk('múltiples fallos de envío');
      }

      const isRetryable = job.retryable && job.attempts < job.maxAttempts;

      if (isRetryable) {
        this.logger.warn(
          `Job falló (intento ${job.attempts}/${job.maxAttempts}). Reencolar al final.`,
        );
        this.queue.push(job);
      } else {
        this.logger.error(
          `Job descartado tras ${job.attempts} intento(s): ${error?.message}`,
        );
        job.reject(error);
      }
    }
  }

  private calculateDelay(): number {
    const config = WARMUP_CONFIG[this.warmupLevel];

    if (this.riskLevel === 1 && Math.random() < config.burstChance) {
      const burstDelay = this.randomInt(1000, 3000);
      this.logger.debug(`Burst controlado: ${burstDelay}ms`);
      return burstDelay;
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
    const withRisk = withWarmup * riskMultiplier;

    const jitter = 0.85 + Math.random() * 0.3;
    return Math.floor(withRisk * jitter);
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
    if (
      this.dailySentCount > 0 &&
      this.dailySentCount % 10 === 0 &&
      this.riskLevel > 1
    ) {
      this.riskLevel--;
      this.logger.log(
        `Riesgo reducido a ${this.riskLevel}/${this.MAX_RISK_LEVEL} por envíos exitosos`,
      );
    }
  }

  private tryResetRisk(): void {
    const now = Date.now();
    const sinceReset = now - this.lastRiskReset;
    if (
      this.riskLevel > 1 &&
      this.recentFailures === 0 &&
      sinceReset > this.RISK_RESET_INTERVAL
    ) {
      this.riskLevel = Math.max(1, this.riskLevel - 1);
      this.lastRiskReset = now;
      this.logger.log(
        `Riesgo reducido pasivamente a ${this.riskLevel}/${this.MAX_RISK_LEVEL}`,
      );
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
    const now = new Date();
    const hour = now.getHours();
    if (hour >= this.ACTIVE_HOUR_START && hour < this.ACTIVE_HOUR_END) return 0;

    const next = new Date(now);
    next.setHours(this.ACTIVE_HOUR_START, 0, 0, 0);
    if (hour >= this.ACTIVE_HOUR_END) next.setDate(next.getDate() + 1);

    return next.getTime() - now.getTime();
  }

  private getWaitUntilTomorrow(): number {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(this.ACTIVE_HOUR_START, 0, 0, 0);
    return tomorrow.getTime() - Date.now();
  }

  private resetDailyCountIfNeeded(): void {
    const today = new Date().toDateString();
    if (today !== this.lastDayRest) {
      this.dailySentCount = 0;
      this.recentFailures = 0;
      this.recentDisconnects = 0;
      this.lastDayRest = today;
      this.logger.log('Contadores diarios reseteados');
    }
  }

  private recordSent(): void {
    const now = Date.now();
    this.sentTimestamps.push(now);
    this.dailySentCount++;
    this.messagesSinceBreak++;
  }

  private randomInt(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  private sleep(ms: number) {
    return new Promise((r) => {
      setTimeout(r, ms);
    });
  }
}
