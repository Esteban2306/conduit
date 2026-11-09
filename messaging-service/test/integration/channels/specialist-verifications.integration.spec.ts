jest.mock('@whiskeysockets/baileys', () => ({
  __esModule: true,
  default: jest.fn(),
  DisconnectReason: { loggedOut: 401 },
}));

import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { SpecialistVerificationService } from 'src/bot/specialists/admin/SpecialistVerificationService';
import { isolatedInfra } from '../../helpers/isolated-env';
import { createTestPrisma } from '../../helpers/prisma.helper';

const infra = isolatedInfra();
const suite = infra ? describe : describe.skip;

const MINUTE = 60_000;

suite('Consulta de verificaciones contra la base aislada', () => {
  const run = randomUUID().slice(0, 8);
  const tenantA = `it-va-${run}`;
  const tenantB = `it-vb-${run}`;
  const base = Date.now() - 2 * 3_600_000;
  let prisma: PrismaClient;
  let service: SpecialistVerificationService;
  let botA: string;
  let botA2: string;
  let botB: string;
  let specA: string;
  let specB: string;
  const ids: string[] = [];

  const config = {
    get: (key: string) =>
      ({ 'specialists.dryRunPerMinute': 10 })[key] as unknown,
  };

  const make = async (
    over: Partial<{
      tenantId: string;
      botConfigId: string;
      specialistId: string;
      conversationId: string;
      verdict:
        | 'VALID'
        | 'INVALID'
        | 'NEEDS_REVIEW'
        | 'UNREADABLE'
        | 'NOT_APPLICABLE'
        | 'ERROR';
      mode: 'SHADOW' | 'ACTIVE';
      reasonCodes: string[];
      minute: number;
      inputTokens: number | null;
      outputTokens: number | null;
      reviewedAt: Date | null;
    }> = {},
  ) => {
    const tenantId = over.tenantId ?? tenantA;
    const row = await prisma.verificationRecord.create({
      data: {
        tenantId,
        conversationId: over.conversationId ?? 'conv-1',
        botConfigId: over.botConfigId ?? (tenantId === tenantA ? botA : botB),
        specialistId:
          over.specialistId ?? (tenantId === tenantA ? specA : specB),
        capability: 'payment-proof',
        subjectHash: 'a'.repeat(64),
        verdict: over.verdict ?? 'VALID',
        mode: over.mode ?? 'ACTIVE',
        reasonCodes: over.reasonCodes ?? [],
        modelUsed: 'claude-haiku-5-5',
        tokens: 1100,
        inputTokens: over.inputTokens === undefined ? 1000 : over.inputTokens,
        outputTokens: over.outputTokens === undefined ? 100 : over.outputTokens,
        reviewedAt: over.reviewedAt ?? null,
        createdAt: new Date(base + (over.minute ?? 0) * MINUTE),
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    ids.push(row.id);
    return row.id;
  };

  beforeAll(async () => {
    prisma = createTestPrisma(infra!.databaseUrl);
    for (const id of [tenantA, tenantB]) {
      await prisma.tenant.create({ data: { id, name: id, slug: id } });
    }
    const bot = (tenantId: string, name: string) =>
      prisma.botConfig
        .create({ data: { tenantId, name, systemPrompt: 'x' } })
        .then((b) => b.id);
    botA = await bot(tenantA, 'a1');
    botA2 = await bot(tenantA, 'a2');
    botB = await bot(tenantB, 'b1');
    const spec = (tenantId: string) =>
      prisma.specialist
        .create({
          data: {
            tenantId,
            key: 'comprobantes',
            name: 'c',
            capability: 'payment-proof',
            promptTemplate: 'p',
          },
        })
        .then((s) => s.id);
    specA = await spec(tenantA);
    specB = await spec(tenantB);
    service = new SpecialistVerificationService(
      prisma as never,
      {} as never,
      config as never,
    );
  });

  afterAll(async () => {
    const tenants = [tenantA, tenantB];
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

  it('nunca devuelve resultados de otro tenant, ni por listado ni por id', async () => {
    const mine = await make({ minute: 1 });
    const theirs = await make({ tenantId: tenantB, minute: 2 });
    const listed = await service.list(tenantA, { limit: '100' });
    const listedIds = listed.items.map((item) => item.id);
    expect(listedIds).toContain(mine);
    expect(listedIds).not.toContain(theirs);
    await expect(service.get(tenantA, theirs)).rejects.toMatchObject({
      status: 404,
    });
    await expect(service.get(tenantB, theirs)).resolves.toMatchObject({
      id: theirs,
    });
    const crossed = await service.list(tenantA, { specialistId: specB });
    expect(crossed.items).toEqual([]);
  });

  it('presenta tokens desglosados y costo estimado', async () => {
    const id = await make({ minute: 3 });
    const item = await service.get(tenantA, id);
    expect(item.tokens).toEqual({ total: 1100, input: 1000, output: 100 });
    expect(item.estimatedCostUsd).toBeCloseTo(0.0015, 6);
    expect(JSON.stringify(item)).not.toMatch(/imageBase64|buffer/i);
  });

  it('sin desglose (registros antiguos) el costo es null y los tokens NULL', async () => {
    const id = await make({ minute: 4, inputTokens: null, outputTokens: null });
    const item = await service.get(tenantA, id);
    expect(item.tokens).toEqual({ total: 1100, input: null, output: null });
    expect(item.estimatedCostUsd).toBeNull();
  });

  describe('filtros', () => {
    let needsReview: string;
    let reviewed: string;
    let errored: string;
    let shadow: string;
    let otherBot: string;
    let otherConversation: string;

    beforeAll(async () => {
      needsReview = await make({
        verdict: 'NEEDS_REVIEW',
        reasonCodes: ['LOW_CONFIDENCE', 'AMOUNT_UNCLEAR'],
        conversationId: 'conv-filtros',
        minute: 10,
      });
      reviewed = await make({
        verdict: 'NEEDS_REVIEW',
        conversationId: 'conv-filtros',
        reviewedAt: new Date(),
        minute: 11,
      });
      errored = await make({
        verdict: 'ERROR',
        reasonCodes: ['PROVIDER_ERROR'],
        conversationId: 'conv-filtros',
        minute: 12,
      });
      shadow = await make({
        mode: 'SHADOW',
        conversationId: 'conv-filtros',
        minute: 13,
      });
      otherBot = await make({
        botConfigId: botA2,
        conversationId: 'conv-filtros',
        minute: 14,
      });
      otherConversation = await make({
        conversationId: 'conv-otra',
        minute: 15,
      });
    });

    const idsOf = async (query: Record<string, string>) =>
      (await service.list(tenantA, { limit: '100', ...query })).items.map(
        (item) => item.id,
      );

    it('por veredicto', async () => {
      const found = await idsOf({ verdict: 'NEEDS_REVIEW' });
      expect(found).toEqual(expect.arrayContaining([needsReview, reviewed]));
      expect(found).not.toContain(errored);
    });

    it('por código de motivo', async () => {
      expect(await idsOf({ reasonCode: 'AMOUNT_UNCLEAR' })).toEqual([
        needsReview,
      ]);
    });

    it('por los veredictos UNREADABLE y NOT_APPLICABLE', async () => {
      const unreadable = await make({
        verdict: 'UNREADABLE',
        conversationId: 'conv-filtros',
        minute: 16,
      });
      const notApplicable = await make({
        verdict: 'NOT_APPLICABLE',
        conversationId: 'conv-filtros',
        minute: 17,
      });
      expect(await idsOf({ verdict: 'UNREADABLE' })).toEqual([unreadable]);
      expect(await idsOf({ verdict: 'NOT_APPLICABLE' })).toEqual([
        notApplicable,
      ]);
    });

    it('por modo', async () => {
      const found = await idsOf({ mode: 'SHADOW' });
      expect(found).toContain(shadow);
      expect(found).not.toContain(needsReview);
    });

    it('por bot y por conversación', async () => {
      expect(
        await idsOf({ botConfigId: botA2, conversationId: 'conv-filtros' }),
      ).toEqual([otherBot]);
      expect(await idsOf({ conversationId: 'conv-otra' })).toEqual([
        otherConversation,
      ]);
    });

    it('pendientes de revisión: sin revisar y con veredicto dudoso o error', async () => {
      const found = await idsOf({
        pendingReview: 'true',
        conversationId: 'conv-filtros',
      });
      expect(found.sort()).toEqual([needsReview, errored].sort());
    });

    it('por rango de fechas', async () => {
      const from = new Date(base + 12 * MINUTE).toISOString();
      const to = new Date(base + 13 * MINUTE).toISOString();
      expect((await idsOf({ from, to })).sort()).toEqual(
        [errored, shadow].sort(),
      );
    });

    it('combina filtros', async () => {
      expect(
        await idsOf({
          verdict: 'NEEDS_REVIEW',
          reasonCode: 'LOW_CONFIDENCE',
          mode: 'ACTIVE',
          specialistId: specA,
        }),
      ).toEqual([needsReview]);
    });
  });

  describe('paginación', () => {
    it('recorre todo sin repetir ni saltar, aun con la misma fecha', async () => {
      const sameMoment = 50;
      const created: string[] = [];
      for (let i = 0; i < 7; i++) {
        created.push(
          await make({ conversationId: 'conv-pag', minute: sameMoment }),
        );
      }
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await service.list(tenantA, {
          conversationId: 'conv-pag',
          limit: '3',
          ...(cursor && { cursor }),
        });
        seen.push(...page.items.map((item) => item.id));
        cursor = page.nextCursor ?? undefined;
        pages++;
      } while (cursor && pages < 10);

      expect(pages).toBe(3);
      expect(seen).toHaveLength(7);
      expect(new Set(seen).size).toBe(7);
      expect([...seen].sort()).toEqual([...created].sort());
    });

    it('con fechas distintas devuelve lo más reciente primero y sin huecos', async () => {
      const created: string[] = [];
      for (let i = 0; i < 5; i++) {
        created.push(
          await make({ conversationId: 'conv-orden', minute: 70 + i }),
        );
      }
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await service.list(tenantA, {
          conversationId: 'conv-orden',
          limit: '2',
          ...(cursor && { cursor }),
        });
        seen.push(...page.items.map((item) => item.id));
        cursor = page.nextCursor ?? undefined;
        pages++;
      } while (cursor && pages < 10);

      expect(seen).toEqual([...created].reverse());
    });

    it('una página exacta no deja cursor colgado', async () => {
      const page = await service.list(tenantA, {
        conversationId: 'conv-pag',
        limit: '7',
      });
      expect(page.items).toHaveLength(7);
      expect(page.nextCursor).toBeNull();
    });

    it('un cursor de otro tenant no revela filas ajenas', async () => {
      const foreign = await make({
        tenantId: tenantB,
        conversationId: 'conv-pag',
        minute: 60,
      });
      const page = await service.list(tenantB, {
        conversationId: 'conv-pag',
        limit: '1',
      });
      const stolen = page.nextCursor ?? undefined;
      const mine = await service.list(tenantA, {
        conversationId: 'conv-pag',
        limit: '100',
        ...(stolen && { cursor: stolen }),
      });
      expect(mine.items.map((item) => item.id)).not.toContain(foreign);
    });
  });
  describe('revisión humana', () => {
    it('registra la decisión sin tocar veredicto, campos ni consumo', async () => {
      const id = await make({
        verdict: 'NEEDS_REVIEW',
        conversationId: 'conv-rev',
        minute: 80,
      });
      const before = await prisma.verificationRecord.findUniqueOrThrow({
        where: { id },
      });
      const out = await service.review(tenantA, 'user-1', id, {
        decision: 'APPROVED',
        note: 'Revisado a mano',
      });
      expect(out).toMatchObject({
        reviewDecision: 'APPROVED',
        reviewedBy: 'user-1',
        reviewNote: 'Revisado a mano',
      });
      expect(out.reviewedAt).toBeInstanceOf(Date);
      const after = await prisma.verificationRecord.findUniqueOrThrow({
        where: { id },
      });
      expect(after.verdict).toBe(before.verdict);
      expect(after.consumedAt).toBeNull();
      expect(after.fields).toEqual(before.fields);
      expect(after.reasonCodes).toEqual(before.reasonCodes);
      expect(after.mode).toBe(before.mode);
    });

    it('sale de la lista de pendientes tras revisarse', async () => {
      const id = await make({
        verdict: 'ERROR',
        conversationId: 'conv-rev2',
        minute: 81,
      });
      const pending = () =>
        service
          .list(tenantA, { pendingReview: 'true', conversationId: 'conv-rev2' })
          .then((page) => page.items.map((item) => item.id));
      expect(await pending()).toEqual([id]);
      await service.review(tenantA, 'user-1', id, { decision: 'REJECTED' });
      expect(await pending()).toEqual([]);
    });

    it('dos revisiones simultáneas: una gana y la otra recibe 409', async () => {
      const id = await make({
        verdict: 'NEEDS_REVIEW',
        conversationId: 'conv-rev3',
        minute: 82,
      });
      const results = await Promise.allSettled([
        service.review(tenantA, 'user-a', id, { decision: 'APPROVED' }),
        service.review(tenantA, 'user-b', id, { decision: 'REJECTED' }),
      ]);
      const ok = results.filter((r) => r.status === 'fulfilled');
      const failed = results.filter((r) => r.status === 'rejected');
      expect(ok).toHaveLength(1);
      expect(failed).toHaveLength(1);
      expect(failed[0].reason).toMatchObject({
        status: 409,
      });
      const saved = await prisma.verificationRecord.findUniqueOrThrow({
        where: { id },
      });
      const winner = (ok[0] as PromiseFulfilledResult<{ reviewedBy: string }>)
        .value.reviewedBy;
      expect(saved.reviewedBy).toBe(winner);
    });

    it('no se puede revisar de nuevo ni un resultado ya válido', async () => {
      const reviewed = await make({
        verdict: 'NEEDS_REVIEW',
        conversationId: 'conv-rev4',
        minute: 83,
      });
      await service.review(tenantA, 'u', reviewed, { decision: 'APPROVED' });
      await expect(
        service.review(tenantA, 'u2', reviewed, { decision: 'REJECTED' }),
      ).rejects.toMatchObject({ status: 409 });
      const valid = await make({ conversationId: 'conv-rev4', minute: 84 });
      await expect(
        service.review(tenantA, 'u', valid, { decision: 'APPROVED' }),
      ).rejects.toMatchObject({ status: 409 });
    });

    it('otro tenant no puede revisar ni ver que existe', async () => {
      const id = await make({
        verdict: 'NEEDS_REVIEW',
        conversationId: 'conv-rev5',
        minute: 85,
      });
      await expect(
        service.review(tenantB, 'u', id, { decision: 'APPROVED' }),
      ).rejects.toMatchObject({ status: 404 });
      const saved = await prisma.verificationRecord.findUniqueOrThrow({
        where: { id },
      });
      expect(saved.reviewedAt).toBeNull();
    });
  });
});
