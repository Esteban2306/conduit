import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client: Redis;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    this.client = new Redis({
      host: this.config.get<string>('REDIS_HOST') ?? 'localhost',
      port: this.config.get<number>('REDIS_PORT') ?? 6379,
      lazyConnect: true,
      enableOfflineQueue: false,
    });

    this.client.on('connect', () => this.logger.log('Redis connected'));
    this.client.on('error', (err) =>
      this.logger.error(`Redis error, ${err.message}`),
    );
  }

  async onModuleDestroy() {
    await this.client.quit();
  }

  getClient(): Redis {
    return this.client;
  }

  async ping(): Promise<{
    status: string;
    latencyMs?: number;
    error?: string;
  }> {
    const start = Date.now();
    try {
      const result = await this.client.ping();
      if (result !== 'PONG') throw new Error('Respuesta inesperada de Redis');
      return { status: 'ok', latencyMs: Date.now() - start };
    } catch (error) {
      return {
        status: 'error',
        error: error instanceof Error ? error.message : 'Unknown Redis error',
      };
    }
  }
}
