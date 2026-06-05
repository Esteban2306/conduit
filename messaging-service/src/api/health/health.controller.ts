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
    const allHealthy = dbStatus.status === 'ok' && redisStatus.status === 'ok';

    return {
      status: allHealthy ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      environment: this.configService.get('app.nodeEnv', { infer: true }),
      version: process.env.npm_package_version ?? '1.0.0',
      service: {
        database: dbStatus,
        redis: redisStatus,
      },
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
