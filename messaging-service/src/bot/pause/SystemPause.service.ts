import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/shared/prisma.service';

export interface SystemPauseState {
  paused: boolean;
  pausedAt: Date | null;
}

const CACHE_TTL_MS = 5_000;

@Injectable()
export class SystemPauseService {
  private readonly cache = new Map<
    string,
    { state: SystemPauseState; expiresAt: number }
  >();

  constructor(private readonly prisma: PrismaService) {}

  async get(tenantId: string): Promise<SystemPauseState> {
    const cached = this.cache.get(tenantId);
    if (cached && cached.expiresAt > Date.now()) return cached.state;

    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { systemPausedAt: true },
    });
    const pausedAt = tenant?.systemPausedAt ?? null;
    const state = { paused: pausedAt !== null, pausedAt };
    this.cache.set(tenantId, { state, expiresAt: Date.now() + CACHE_TTL_MS });
    return state;
  }

  async isPaused(tenantId: string): Promise<boolean> {
    return (await this.get(tenantId)).paused;
  }

  async set(tenantId: string, paused: boolean): Promise<SystemPauseState> {
    const current = await this.get(tenantId);
    if (current.paused === paused) return current;

    const updated = await this.prisma.tenant.update({
      where: { id: tenantId },
      data: { systemPausedAt: paused ? new Date() : null },
      select: { systemPausedAt: true },
    });
    const pausedAt = updated.systemPausedAt;
    const state = { paused: pausedAt !== null, pausedAt };
    this.cache.set(tenantId, { state, expiresAt: Date.now() + CACHE_TTL_MS });
    return state;
  }
}
