import { Injectable, Logger } from '@nestjs/common';
import { BaileysRateLimiter, WarmupLevel } from './BaileysRateLimiter';

@Injectable()
export class BaileysRateLimiterRegistry {
  private readonly logger = new Logger(BaileysRateLimiterRegistry.name);
  private readonly limiters = new Map<string, BaileysRateLimiter>();

  getOrCreate(
    connectionId: string,
    warmupLevel: WarmupLevel,
  ): BaileysRateLimiter {
    let limiter = this.limiters.get(connectionId);
    if (!limiter) {
      limiter = new BaileysRateLimiter(connectionId, warmupLevel);
      this.limiters.set(connectionId, limiter);
      this.logger.log(
        `Rate limiter creado para conexión ${connectionId} (nivel: ${warmupLevel})`,
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
    };
  }
}
