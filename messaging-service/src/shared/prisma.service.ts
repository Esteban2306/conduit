import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { migrationsOnDisk, pendingMigrations } from './pending-migrations';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy, OnApplicationBootstrap
{
  private readonly migrationLogger = new Logger('Migraciones');

  async onModuleInit() {
    await this.$connect();
  }

  async onApplicationBootstrap() {
    const pending = await this.pendingMigrations();
    if (pending.length > 0) {
      this.migrationLogger.error(
        `Hay ${pending.length} migración(es) sin aplicar en esta base de datos: ${pending.join(', ')}. ` +
          `Hasta aplicarlas, las consultas que usen las tablas o columnas nuevas fallarán. Ejecuta: npx prisma migrate deploy`,
      );
    }
  }

  async pendingMigrations(): Promise<string[]> {
    try {
      const rows = await this.$queryRaw<Array<{ migration_name: string }>>`
        SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL
      `;
      return pendingMigrations({
        applied: rows.map((r) => r.migration_name),
        onDisk: migrationsOnDisk(),
      });
    } catch {
      return [];
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
