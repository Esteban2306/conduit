import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  MessageChannel,
  MessageStatus,
  OutboundReplyStatus,
} from '@prisma/client';
import { PrismaService } from 'src/shared/prisma.service';
import {
  BaileysRateLimiter,
  DEFAULT_ACTIVE_HOURS_TIMEZONE,
  WarmupLevel,
} from './BaileysRateLimiter';

@Injectable()
export class BaileysRateLimiterRegistry
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(BaileysRateLimiterRegistry.name);
  private readonly limiters = new Map<string, BaileysRateLimiter>();
  private sweepInterval: NodeJS.Timeout | null = null;

  private readonly SWEEP_INTERVAL_MS = 5 * 60 * 1000;
  private readonly timeZone: string;

  private readonly hydrated = new Set<string>();

  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.timeZone =
      config.get<string>('whatsapp.timeZone') ?? DEFAULT_ACTIVE_HOURS_TIMEZONE;
  }

  onModuleInit(): void {
    this.sweepInterval = setInterval(
      () => this.sweepAll(),
      this.SWEEP_INTERVAL_MS,
    );
  }

  onModuleDestroy(): void {
    if (this.sweepInterval) clearInterval(this.sweepInterval);
  }

  private sweepAll(): void {
    for (const limiter of this.limiters.values()) {
      limiter.tick();
    }
  }

  getOrCreate(
    connectionId: string,
    warmupLevel: WarmupLevel,
  ): BaileysRateLimiter {
    let limiter = this.limiters.get(connectionId);
    if (!limiter) {
      limiter = new BaileysRateLimiter(
        connectionId,
        warmupLevel,
        this.timeZone,
      );
      limiter.setRiskListener((level) => this.persistRisk(connectionId, level));
      this.limiters.set(connectionId, limiter);
      this.logger.log(
        `Rate limiter creado para conexión ${connectionId} (nivel: ${warmupLevel}, zona: ${this.timeZone})`,
      );
    }
    return limiter;
  }

  /**
   * Recupera el estado del limitador desde la base la primera vez que se usa
   * la conexión en este proceso: lo enviado en la última hora y día y el
   * riesgo guardado, para que un reinicio no reinicie también los topes.
   */
  async hydrate(connectionId: string): Promise<void> {
    const limiter = this.limiters.get(connectionId);
    if (!limiter || this.hydrated.has(connectionId)) return;
    this.hydrated.add(connectionId);

    const now = Date.now();
    const [replies, campaigns, connection] = await Promise.all([
      this.prisma.outboundReply.findMany({
        where: {
          connectionId,
          status: OutboundReplyStatus.SENT,
          sentAt: { gte: new Date(now - 3_600_000) },
        },
        select: { sentAt: true },
      }),
      this.prisma.message.findMany({
        where: {
          connectionId,
          channel: MessageChannel.WHATSAPP,
          status: MessageStatus.SENT,
          sentAt: { gte: new Date(now - 86_400_000) },
        },
        select: { sentAt: true },
      }),
      this.prisma.whatsAppConnection.findUnique({
        where: { id: connectionId },
        select: { riskLevel: true, riskUpdatedAt: true },
      }),
    ]);

    const times = (rows: Array<{ sentAt: Date | null }>) =>
      rows.flatMap((r) => (r.sentAt ? [r.sentAt.getTime()] : []));
    limiter.hydrate({
      conversationSentAt: times(replies),
      campaignSentAt: times(campaigns),
      riskLevel: connection?.riskLevel ?? 1,
      riskUpdatedAt: connection?.riskUpdatedAt ?? null,
    });
  }

  private persistRisk(connectionId: string, level: number): void {
    this.prisma.whatsAppConnection
      .update({
        where: { id: connectionId },
        data: { riskLevel: level, riskUpdatedAt: new Date() },
      })
      .catch((error: unknown) => {
        this.logger.warn(
          `No fue posible guardar el nivel de riesgo de ${connectionId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }

  get(connectionId: string): BaileysRateLimiter | undefined {
    return this.limiters.get(connectionId);
  }

  updateWarmupLevel(connectionId: string, level: WarmupLevel): void {
    const limiter = this.limiters.get(connectionId);
    if (limiter) {
      limiter.setWarmupLevel(level);
    }
  }

  enterReconnectThrottle(connectionId: string): void {
    this.limiters.get(connectionId)?.enterReconnectThrottle();
  }

  reportDisconnect(connectionId: string): void {
    this.limiters.get(connectionId)?.reportDisconnect();
  }

  remove(connectionId: string): void {
    this.limiters.delete(connectionId);
    this.hydrated.delete(connectionId);
  }

  getStatus(connectionId: string) {
    const limiter = this.limiters.get(connectionId);
    if (!limiter) return null;
    return {
      warmupLevel: limiter.getWarmupLevel(),
      riskLevel: limiter.getRiskLevel(),
      queueSize: limiter.getQueueSize(),
      lanes: limiter.getLaneSizes(),
    };
  }
}
