import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/shared/prisma.service';
import { ModelPrice, buildPriceTable, estimateCostUsd } from '../pricing';
import { parseOrThrow } from './specialist-admin.schemas';
import {
  DEFAULT_METRICS_DAYS,
  TOP_REASON_CODES,
  metricsQuerySchema,
} from './specialist-metrics.schemas';

const DAY_MS = 86_400_000;
const REUSE_CODES = [
  'ALREADY_USED',
  'REUSED_OTHER_CONTACT',
  'RESENT_SAME_IMAGE',
  'RESENT_SAME_RECEIPT',
] as const;
const VERDICTS = ['VALID', 'INVALID', 'NEEDS_REVIEW', 'ERROR'] as const;

const count = (value: bigint | number | null | undefined): number =>
  Number(value ?? 0);
const rate = (part: number, total: number): number | null =>
  total === 0 ? null : Math.round((part / total) * 10_000) / 10_000;
const round = (value: number | null): number | null =>
  value === null ? null : Math.round(value);

@Injectable()
export class SpecialistMetricsService {
  private readonly prices: Record<string, ModelPrice>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    this.prices = buildPriceTable(
      this.config.get<string>('specialists.priceTable'),
    );
  }

  async summary(tenantId: string, query: unknown) {
    const filters = parseOrThrow(metricsQuerySchema, query);
    const to = filters.to ? new Date(filters.to) : new Date();
    const from = filters.from
      ? new Date(filters.from)
      : new Date(to.getTime() - DEFAULT_METRICS_DAYS * DAY_MS);

    const where = Prisma.join(
      [
        Prisma.sql`"tenantId" = ${tenantId}`,
        Prisma.sql`"createdAt" >= ${from}`,
        Prisma.sql`"createdAt" <= ${to}`,
        ...(filters.specialistId
          ? [Prisma.sql`"specialistId" = ${filters.specialistId}`]
          : []),
        ...(filters.botConfigId
          ? [Prisma.sql`"botConfigId" = ${filters.botConfigId}`]
          : []),
        ...(filters.capability
          ? [Prisma.sql`"capability" = ${filters.capability}`]
          : []),
        ...(filters.mode
          ? [Prisma.sql`"mode" = ${filters.mode}::"SpecialistBindingMode"`]
          : []),
      ],
      ' AND ',
    );

    const [verdicts, latency, errors, reviews, reuse, models, agreement] =
      await Promise.all([
        this.prisma.$queryRaw<Array<{ verdict: string; n: bigint }>>`
          SELECT "verdict"::text AS verdict, COUNT(*) AS n
          FROM "VerificationRecord" WHERE ${where} GROUP BY "verdict"`,
        this.prisma.$queryRaw<
          Array<{ n: bigint; p50: number | null; p95: number | null }>
        >`
          SELECT COUNT(*) AS n,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY "latencyMs") AS p50,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY "latencyMs") AS p95
          FROM "VerificationRecord"
          WHERE ${where} AND "modelUsed" IS NOT NULL`,
        this.reasons(where, 'ERROR'),
        this.reasons(where, 'NEEDS_REVIEW'),
        this.prisma.$queryRaw<Array<{ code: string; n: bigint }>>`
          SELECT code, COUNT(*) AS n
          FROM "VerificationRecord", unnest("reasonCodes") AS code
          WHERE ${where} AND code = ANY(${[...REUSE_CODES]}::text[])
          GROUP BY code`,
        this.prisma.$queryRaw<
          Array<{
            model: string | null;
            calls: bigint;
            total: bigint;
            withBreakdown: bigint;
            input: bigint | null;
            output: bigint | null;
          }>
        >`
          SELECT "modelUsed" AS model, COUNT(*) AS calls,
            COALESCE(SUM("tokens"), 0) AS total,
            COUNT("inputTokens") AS "withBreakdown",
            SUM("inputTokens") AS input, SUM("outputTokens") AS output
          FROM "VerificationRecord"
          WHERE ${where} AND "modelUsed" IS NOT NULL
          GROUP BY "modelUsed"`,
        this.prisma.$queryRaw<Array<{ compared: bigint; agreed: bigint }>>`
          SELECT COUNT(*) AS compared,
            COUNT(*) FILTER (WHERE "comparison"->>'agrees' = 'true') AS agreed
          FROM "VerificationRecord"
          WHERE ${where} AND "mode" = 'SHADOW'::"SpecialistBindingMode"
            AND "comparison" IS NOT NULL`,
      ]);

    const byVerdict = Object.fromEntries(VERDICTS.map((v) => [v, 0])) as Record<
      (typeof VERDICTS)[number],
      number
    >;
    for (const row of verdicts) {
      if (row.verdict in byVerdict) {
        byVerdict[row.verdict as keyof typeof byVerdict] = count(row.n);
      }
    }
    const total = VERDICTS.reduce((sum, v) => sum + byVerdict[v], 0);

    let inputTokens = 0;
    let outputTokens = 0;
    let totalTokens = 0;
    let withBreakdown = 0;
    let modelCalls = 0;
    let costUsd = 0;
    let callsExcludedFromCost = 0;
    const byModel = models.map((row) => {
      const input = count(row.input);
      const output = count(row.output);
      const calls = count(row.calls);
      const covered = count(row.withBreakdown);
      const cost = estimateCostUsd(this.prices, row.model, input, output);
      inputTokens += input;
      outputTokens += output;
      totalTokens += count(row.total);
      withBreakdown += covered;
      modelCalls += calls;
      callsExcludedFromCost += cost === null ? calls : calls - covered;
      if (cost !== null) costUsd += cost;
      return {
        model: row.model,
        calls,
        tokens: { total: count(row.total), input, output },
        callsWithoutBreakdown: calls - covered,
        estimatedCostUsd: cost,
      };
    });

    const compared = count(agreement[0]?.compared);
    const agreed = count(agreement[0]?.agreed);
    const reuseCounts = Object.fromEntries(REUSE_CODES.map((c) => [c, 0]));
    for (const row of reuse) reuseCounts[row.code] = count(row.n);

    return {
      range: { from: from.toISOString(), to: to.toISOString() },
      total,
      verdicts: Object.fromEntries(
        VERDICTS.map((v) => [
          v,
          { count: byVerdict[v], rate: rate(byVerdict[v], total) },
        ]),
      ),
      latencyMs: {
        sample: count(latency[0]?.n),
        p50: round(latency[0]?.p50 ?? null),
        p95: round(latency[0]?.p95 ?? null),
      },
      degradationsByReason: errors,
      reviewsByReason: reviews,
      reuse: reuseCounts,
      tokens: {
        total: totalTokens,
        input: inputTokens,
        output: outputTokens,
        modelCalls,
        callsWithoutBreakdown: modelCalls - withBreakdown,
      },
      estimatedCostUsd: {
        total: Math.round(costUsd * 1e6) / 1e6,
        callsExcludedFromCost,
        byModel,
      },
      shadowAgreement: {
        compared,
        agreed,
        rate: rate(agreed, compared),
      },
    };
  }

  private async reasons(where: Prisma.Sql, verdict: 'ERROR' | 'NEEDS_REVIEW') {
    const rows = await this.prisma.$queryRaw<
      Array<{ code: string; n: bigint }>
    >`
      SELECT code, COUNT(*) AS n
      FROM "VerificationRecord", unnest("reasonCodes") AS code
      WHERE ${where} AND "verdict" = ${verdict}::"VerificationVerdict"
      GROUP BY code ORDER BY n DESC, code ASC LIMIT ${TOP_REASON_CODES}`;
    return rows.map((row) => ({ code: row.code, count: count(row.n) }));
  }
}
