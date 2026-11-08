import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/shared/prisma.service';

export interface SystemPauseState {
  paused: boolean;
  pausedAt: Date | null;
}

const CACHE_TTL_MS = 5_000;

@Injectable()
export class SystemPauseService {
  private readonly logger = new Logger(SystemPauseService.name);
  private readonly cache = new Map<
    string,
    { state: SystemPauseState; expiresAt: number }
  >();

  constructor(private readonly prisma: PrismaService) {}

  async get(tenantId: string): Promise<SystemPauseState> {
    const cached = this.cache.get(tenantId);
    if (cached && cached.expiresAt > Date.now()) return cached.state;

    try {
      const tenant = await this.prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { systemPausedAt: true },
      });
      const pausedAt = tenant?.systemPausedAt ?? null;
      return this.remember(tenantId, { paused: pausedAt !== null, pausedAt });
    } catch (error) {
      this.logger.warn(
        `No se pudo leer la pausa del sistema del tenant ${tenantId}; se usa el último estado conocido: ${(error as Error).message}`,
      );
      return cached?.state ?? { paused: false, pausedAt: null };
    }
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
    return this.remember(tenantId, { paused: pausedAt !== null, pausedAt });
  }

  private remember(
    tenantId: string,
    state: SystemPauseState,
  ): SystemPauseState {
    this.cache.set(tenantId, { state, expiresAt: Date.now() + CACHE_TTL_MS });
    return state;
  }
}
