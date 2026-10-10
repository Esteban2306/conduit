import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { PrismaService } from 'src/shared/prisma.service';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from 'src/config';
import { RedisService } from 'src/shared/redis';
import { Public } from '../middlewares/auth';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly configService: ConfigService<AppConfig>,
  ) {}

  @Get()
  @Public()
  @ApiOperation({
    summary: 'Check the health of the microservice and its dependencises',
  })
  async cheak() {
    const [dbStatus, redisStatus] = await Promise.all([
      this.checkDatabase(),
      this.redis.ping(),
    ]);
    const whatsapp =
      dbStatus.status === 'ok' ? await this.checkWhatsApp() : null;
    const allHealthy =
      dbStatus.status === 'ok' &&
      redisStatus.status === 'ok' &&
      whatsapp?.status === 'ok';

    return {
      status: allHealthy ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      environment: this.configService.get('app.nodeEnv', { infer: true }),
      version: process.env.npm_package_version ?? '1.0.0',
      service: {
        database: dbStatus,
        redis: redisStatus,
        whatsapp,
      },
    };
  }

  /**
   * Resumen agregado (sin ids ni números: el endpoint es público). Se
   * degrada si alguna conexión cayó en ERROR/BANNED, que es cuando se
   * requiere intervención humana (QR nuevo o número bloqueado).
   */
  private async checkWhatsApp() {
    const groups = await this.prisma.whatsAppConnection.groupBy({
      by: ['status'],
      _count: { _all: true },
    });
    const counts: Record<string, number> = {};
    for (const group of groups) counts[group.status] = group._count._all;

    const needsAttention = (counts.ERROR ?? 0) + (counts.BANNED ?? 0);
    return {
      status: needsAttention > 0 ? 'attention_required' : 'ok',
      connections: counts,
    };
  }

  private async checkDatabase(): Promise<{
    status: string;
    latencyMs?: number;
    error?: string;
  }> {
    const start = Date.now();
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return {
        status: 'ok',
        latencyMs: Date.now() - start,
      };
    } catch (error) {
      return {
        status: 'error',
        error:
          error instanceof Error ? error.message : 'Unknown database error',
      };
    }
  }
}
