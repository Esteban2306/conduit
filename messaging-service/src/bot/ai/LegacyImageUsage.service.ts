import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/shared/prisma.service';

export const LEGACY_USAGE_MIGRATION = '20261112120000_legacy_image_usage';
export const DEFAULT_WINDOW_DAYS = 14;
export const MAX_WINDOW_DAYS = 90;
const DAY_MS = 86_400_000;

/**
 * Cuenta el uso del análisis de imagen antiguo para decidir con datos cuándo
 * retirarlo. Nunca lanza ni retrasa el turno.
 */
@Injectable()
export class LegacyImageUsageService {
  private readonly logger = new Logger(LegacyImageUsageService.name);

  constructor(private readonly prisma: PrismaService) {}

  record(tenantId: string, botConfigId: string): void {
    try {
      void this.prisma.$executeRaw`
          INSERT INTO "LegacyImageUsage" ("tenantId", "botConfigId", "day", "calls", "lastAt")
          VALUES (${tenantId}, ${botConfigId}, (NOW() AT TIME ZONE 'UTC')::date, 1, NOW())
          ON CONFLICT ("botConfigId", "day")
          DO UPDATE SET "calls" = "LegacyImageUsage"."calls" + 1, "lastAt" = NOW()`.catch(
        (error: unknown) => this.logFailure(error),
      );
    } catch (error) {
      this.logFailure(error);
    }
    this.logger.warn(
      `Imagen analizada con el camino antiguo (bot ${botConfigId}, tenant ${tenantId}).`,
    );
  }

  async summary(tenantId: string, rawDays?: number) {
    const days = Math.min(
      Math.max(Math.trunc(rawDays ?? DEFAULT_WINDOW_DAYS) || 1, 1),
      MAX_WINDOW_DAYS,
    );

    const rows = await this.prisma.$queryRaw<
      Array<{
        botConfigId: string;
        calls: bigint;
        lastAt: Date;
      }>
    >`
      SELECT "botConfigId", SUM("calls")::bigint AS calls, MAX("lastAt") AS "lastAt"
      FROM "LegacyImageUsage"
      WHERE "tenantId" = ${tenantId}
        AND "day" > (NOW() AT TIME ZONE 'UTC')::date - ${days}::int
      GROUP BY "botConfigId"
      ORDER BY calls DESC`;

    const names = new Map(
      (
        await this.prisma.botConfig.findMany({
          where: { tenantId, id: { in: rows.map((r) => r.botConfigId) } },
          select: { id: true, name: true },
        })
      ).map((bot) => [bot.id, bot.name]),
    );

    const bots = rows.map((row) => ({
      botConfigId: row.botConfigId,
      name: names.get(row.botConfigId) ?? null,
      calls: Number(row.calls),
      lastUsedAt: row.lastAt,
    }));
    const totalCalls = bots.reduce((sum, bot) => sum + bot.calls, 0);

    const observedSince = await this.observedSince();
    const observedDays =
      observedSince === null
        ? 0
        : Math.floor((Date.now() - observedSince.getTime()) / DAY_MS);

    return {
      windowDays: days,
      observedSince,
      observedDays,
      totalCalls,
      lastUsedAt: bots.length
        ? new Date(Math.max(...bots.map((b) => b.lastUsedAt.getTime())))
        : null,
      bots,
      // Solo se puede decir "sin uso" si el contador lleva observando toda la
      // ventana: sin eso, cero llamadas no prueba nada.
      retirementReady: observedDays >= days && totalCalls === 0,
    };
  }

  /** Desde cuándo existe el contador: cuándo se aplicó su migración. */
  private async observedSince(): Promise<Date | null> {
    try {
      const rows = await this.prisma.$queryRaw<Array<{ at: Date | null }>>`
        SELECT finished_at AS at FROM "_prisma_migrations"
        WHERE migration_name = ${LEGACY_USAGE_MIGRATION}
          AND finished_at IS NOT NULL
        LIMIT 1`;
      return rows[0]?.at ?? null;
    } catch {
      return null;
    }
  }

  private logFailure(error: unknown): void {
    this.logger.warn(
      `No se pudo registrar el uso del camino antiguo: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
