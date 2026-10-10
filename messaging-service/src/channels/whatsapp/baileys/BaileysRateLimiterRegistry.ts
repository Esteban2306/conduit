import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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

  constructor(config: ConfigService) {
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
      this.limiters.set(connectionId, limiter);
      this.logger.log(
        `Rate limiter creado para conexión ${connectionId} (nivel: ${warmupLevel}, zona: ${this.timeZone})`,
      );
    }
    return limiter;
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
