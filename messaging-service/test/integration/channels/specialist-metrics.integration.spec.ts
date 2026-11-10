jest.mock('@whiskeysockets/baileys', () => ({
  __esModule: true,
  default: jest.fn(),
  DisconnectReason: { loggedOut: 401 },
}));

import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { SpecialistMetricsService } from 'src/bot/specialists/admin/SpecialistMetricsService';
import { isolatedInfra } from '../../helpers/isolated-env';
import { createTestPrisma } from '../../helpers/prisma.helper';

const infra = isolatedInfra();
const suite = infra ? describe : describe.skip;

type Verdict =
  | 'VALID'
  | 'INVALID'
  | 'NEEDS_REVIEW'
  | 'UNREADABLE'
  | 'NOT_APPLICABLE'
  | 'ERROR';

suite('Métricas de verificaciones contra la base aislada', () => {
  const run = randomUUID().slice(0, 8);
  const tenantA = `it-ma-${run}`;
  const tenantB = `it-mb-${run}`;
  const tenantEmpty = `it-me-${run}`;
  let prisma: PrismaClient;
  let service: SpecialistMetricsService;
  let botA: string;
  let specA: string;
  let specA2: string;
  let specA3: string;
  let botB: string;
  let specB: string;

  const config = { get: () => undefined };

  const make = (
    over: {
      tenantId?: string;
      specialistId?: string;
      verdict?: Verdict;
      mode?: 'SHADOW' | 'ACTIVE';
      reasonCodes?: string[];
      latencyMs?: number;
      modelUsed?: string | null;
      tokens?: number;
      inputTokens?: number | null;
      outputTokens?: number | null;
      comparison?: { agrees: boolean } | null;
      daysAgo?: number;
    } = {},
  ) => {
    const tenantId = over.tenantId ?? tenantA;
    const isA = tenantId === tenantA;
    return prisma.verificationRecord.create({
      data: {
        tenantId,
        conversationId: 'c',
        botConfigId: isA ? botA : botB,
        specialistId: over.specialistId ?? (isA ? specA : specB),
        capability: 'payment-proof',
        subjectHash: 'a'.repeat(64),
        verdict: over.verdict ?? 'VALID',
        mode: over.mode ?? 'ACTIVE',
        reasonCodes: over.reasonCodes ?? [],
        modelUsed:
          over.modelUsed === undefined ? 'claude-haiku-5-5' : over.modelUsed,
        tokens: over.tokens ?? 1100,
        inputTokens: over.inputTokens === undefined ? 1000 : over.inputTokens,
        outputTokens: over.outputTokens === undefined ? 100 : over.outputTokens,
        latencyMs: over.latencyMs ?? 3000,
        comparison: over.comparison ?? undefined,
        createdAt: new Date(
          Date.now() - (over.daysAgo ?? 0) * 86_400_000 - 60_000,
        ),
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
  };

  beforeAll(async () => {
    prisma = createTestPrisma(infra!.databaseUrl);
    for (const id of [tenantA, tenantB, tenantEmpty]) {
      await prisma.tenant.create({ data: { id, name: id, slug: id } });
    }
    const bot = (tenantId: string) =>
      prisma.botConfig
        .create({ data: { tenantId, name: 'b', systemPrompt: 'x' } })
        .then((b) => b.id);
    botA = await bot(tenantA);
    botB = await bot(tenantB);
    const spec = (tenantId: string, key: string) =>
      prisma.specialist
        .create({
          data: {
            tenantId,
            key,
            name: key,
            capability: 'payment-proof',
            promptTemplate: 'p',
          },
        })
        .then((s) => s.id);
    specA = await spec(tenantA, 'uno');
    specA2 = await spec(tenantA, 'dos');
    specA3 = await spec(tenantA, 'tres');
    specB = await spec(tenantB, 'uno');
    service = new SpecialistMetricsService(prisma as never, config as never);

    for (const latencyMs of [1000, 2000, 3000]) await make({ latencyMs });
    await make({ verdict: 'INVALID', latencyMs: 4000 });
    await make({
      verdict: 'NEEDS_REVIEW',
      latencyMs: 5000,
      reasonCodes: ['LOW_CONFIDENCE'],
    });
    await make({
      verdict: 'ERROR',
      modelUsed: null,
      tokens: 0,
      inputTokens: null,
      outputTokens: null,
      latencyMs: 12000,
      reasonCodes: ['TIMEOUT'],
    });
    await make({
      verdict: 'ERROR',
      modelUsed: null,
      tokens: 0,
      inputTokens: null,
      outputTokens: null,
      latencyMs: 100,
      reasonCodes: ['PROVIDER_ERROR'],
    });
    await make({
      verdict: 'INVALID',
      modelUsed: null,
      tokens: 0,
      inputTokens: null,
      outputTokens: null,
      latencyMs: 5,
      reasonCodes: ['ALREADY_USED'],
    });
    for (const comparison of [
      { agrees: true },
      { agrees: true },
      { agrees: false },
      null,
    ]) {
      await make({ mode: 'SHADOW', comparison });
    }
    await make({
      modelUsed: 'modelo-raro',
      tokens: 500,
      inputTokens: null,
      outputTokens: null,
    });
    await make({ daysAgo: 30, verdict: 'ERROR', reasonCodes: ['OLD_CODE'] });
    await make({
      tenantId: tenantB,
      verdict: 'ERROR',
      reasonCodes: ['B_CODE'],
    });
    await make({ specialistId: specA2, verdict: 'INVALID' });
    await make({ specialistId: specA3, verdict: 'UNREADABLE' });
    await make({ specialistId: specA3, verdict: 'UNREADABLE' });
    await make({ specialistId: specA3, verdict: 'NOT_APPLICABLE' });
    await make({ specialistId: specA3, verdict: 'VALID' });
  });

  afterAll(async () => {
    const tenants = [tenantA, tenantB, tenantEmpty];
    await prisma.verificationRecord.deleteMany({
      where: { tenantId: { in: tenants } },
    });
    await prisma.specialist.deleteMany({
      where: { tenantId: { in: tenants } },
    });
    await prisma.botConfig.deleteMany({ where: { tenantId: { in: tenants } } });
    await prisma.tenant.deleteMany({ where: { id: { in: tenants } } });
    await prisma.$disconnect();
  });

  const only = { specialistId: '' };

  it('cuenta veredictos con su tasa, solo del tenant y del rango', async () => {
    only.specialistId = specA;
    const out = await service.summary(tenantA, only);
    expect(out.total).toBe(13);
    expect(out.verdicts.VALID).toEqual({ count: 8, rate: 0.6154 });
    expect(out.verdicts.INVALID.count).toBe(2);
    expect(out.verdicts.NEEDS_REVIEW.count).toBe(1);
    expect(out.verdicts.ERROR.count).toBe(2);
  });

  it('cuenta los seis veredictos y el total los suma todos', async () => {
    const out = await service.summary(tenantA, { specialistId: specA3 });
    expect(out.total).toBe(4);
    expect(out.verdicts.UNREADABLE).toEqual({ count: 2, rate: 0.5 });
    expect(out.verdicts.NOT_APPLICABLE).toEqual({ count: 1, rate: 0.25 });
    expect(out.verdicts.VALID.count).toBe(1);
    const sum = Object.values(out.verdicts).reduce(
      (acc, v) => acc + v.count,
      0,
    );
    expect(sum).toBe(out.total);
  });

  it('latencia p50 y p95 solo sobre llamadas al modelo', async () => {
    const out = await service.summary(tenantA, { specialistId: specA });
    expect(out.latencyMs).toEqual({ sample: 10, p50: 3000, p95: 4550 });
  });

  it('degradaciones y revisiones por código de motivo', async () => {
    const out = await service.summary(tenantA, { specialistId: specA });
    expect(out.degradationsByReason).toEqual([
      { code: 'PROVIDER_ERROR', count: 1 },
      { code: 'TIMEOUT', count: 1 },
    ]);
    expect(out.reviewsByReason).toEqual([{ code: 'LOW_CONFIDENCE', count: 1 }]);
  });

  it('cuenta las reutilizaciones', async () => {
    const out = await service.summary(tenantA, { specialistId: specA });
    expect(out.reuse).toEqual({
      ALREADY_USED: 1,
      REUSED_OTHER_CONTACT: 0,
      RESENT_SAME_IMAGE: 0,
      RESENT_SAME_RECEIPT: 0,
    });
  });

  it('tokens y costo: lo sin desglose o sin precio no se inventa', async () => {
    const out = await service.summary(tenantA, { specialistId: specA });
    expect(out.tokens).toEqual({
      total: 10400,
      input: 9000,
      output: 900,
      modelCalls: 10,
      callsWithoutBreakdown: 1,
    });
    expect(out.estimatedCostUsd.total).toBeCloseTo(0.0135, 6);
    expect(out.estimatedCostUsd.callsExcludedFromCost).toBe(1);
    const raro = out.estimatedCostUsd.byModel.find(
      (m) => m.model === 'modelo-raro',
    );
    expect(raro).toMatchObject({
      calls: 1,
      callsWithoutBreakdown: 1,
      estimatedCostUsd: null,
    });
  });

  it('acuerdo de SHADOW solo con casos comparados', async () => {
    const out = await service.summary(tenantA, { specialistId: specA });
    expect(out.shadowAgreement).toEqual({
      compared: 3,
      agreed: 2,
      rate: 0.6667,
    });
  });

  it('filtra por modo, especialista y rango', async () => {
    expect(
      (await service.summary(tenantA, { mode: 'SHADOW', specialistId: specA }))
        .total,
    ).toBe(4);
    expect(
      (await service.summary(tenantA, { specialistId: specA2 })).total,
    ).toBe(1);
    const old = await service.summary(tenantA, {
      specialistId: specA,
      from: new Date(Date.now() - 40 * 86_400_000).toISOString(),
      to: new Date(Date.now() - 20 * 86_400_000).toISOString(),
    });
    expect(old.total).toBe(1);
    expect(old.degradationsByReason).toEqual([{ code: 'OLD_CODE', count: 1 }]);
  });

  it('por defecto mira los últimos 7 días', async () => {
    const out = await service.summary(tenantA, {});
    const days =
      (new Date(out.range.to).getTime() - new Date(out.range.from).getTime()) /
      86_400_000;
    expect(days).toBeCloseTo(7, 1);
    expect(out.degradationsByReason.map((d) => d.code)).not.toContain(
      'OLD_CODE',
    );
  });

  it('un tenant nunca ve datos de otro', async () => {
    const b = await service.summary(tenantB, {});
    expect(b.total).toBe(1);
    expect(b.degradationsByReason).toEqual([{ code: 'B_CODE', count: 1 }]);
    const a = await service.summary(tenantA, {});
    expect(a.degradationsByReason.map((d) => d.code)).not.toContain('B_CODE');
    expect(
      (await service.summary(tenantA, { specialistId: specB })).total,
    ).toBe(0);
  });

  it('sin datos devuelve ceros y tasas nulas, no NaN', async () => {
    const out = await service.summary(tenantEmpty, {});
    expect(out.total).toBe(0);
    expect(out.verdicts.VALID).toEqual({ count: 0, rate: null });
    expect(out.latencyMs).toEqual({ sample: 0, p50: null, p95: null });
    expect(out.shadowAgreement).toEqual({
      compared: 0,
      agreed: 0,
      rate: null,
    });
    expect(out.estimatedCostUsd.total).toBe(0);
    expect(out.tokens.modelCalls).toBe(0);
  });

  it.each([
    { tenantId: 'x' },
    { mode: 'OFF' },
    { from: 'ayer' },
    { from: '2026-11-09T00:00:00Z', to: '2026-11-01T00:00:00Z' },
    { from: '2024-01-01T00:00:00Z', to: '2026-11-01T00:00:00Z' },
  ])('rechaza el filtro %j', async (query) => {
    await expect(service.summary(tenantA, query)).rejects.toMatchObject({
      status: 400,
    });
  });
});
