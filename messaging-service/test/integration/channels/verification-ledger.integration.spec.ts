jest.mock('@whiskeysockets/baileys', () => ({
  __esModule: true,
  default: jest.fn(),
  DisconnectReason: { loggedOut: 401 },
}));

import { randomBytes, randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import sharp from 'sharp';
import { SpecialistRuntime } from 'src/bot/specialists/SpecialistRuntime';
import { VerificationLedger } from 'src/bot/specialists/VerificationLedger';
import { isolatedInfra } from '../../helpers/isolated-env';
import { createTestPrisma } from '../../helpers/prisma.helper';

const infra = isolatedInfra();
const suite = infra ? describe : describe.skip;

const HOUR_MS = 3_600_000;
const CAP = 'payment-proof';

suite('VerificationLedger y reutilización contra la base aislada', () => {
  const run = randomUUID().slice(0, 8);
  const tenantA = `it-a-${run}`;
  const tenantB = `it-b-${run}`;
  let prisma: PrismaClient;
  let botA: string;
  let specA: string;
  let counter = 0;

  const config = {
    get: (key: string) =>
      ({
        'specialists.enabled': true,
        'specialists.retentionDays': 30,
        'specialists.passportTtlMinutes': 60,
      })[key],
  };
  const ledger = () => new VerificationLedger(prisma as never, config as never);
  const hashOf = () => `h-${run}-${++counter}`;

  const record = (
    over: {
      tenantId?: string;
      specialistId?: string;
      capability?: string;
      conversationId?: string;
      verdict?: 'VALID' | 'INVALID' | 'NEEDS_REVIEW' | 'ERROR' | 'UNREADABLE';
      mode?: 'ACTIVE' | 'SHADOW';
      hash?: string;
      version?: number;
      fingerprint?: string | null;
      consumedAt?: Date | null;
      createdAt?: Date;
      expiresAt?: Date;
    } = {},
  ) =>
    prisma.verificationRecord.create({
      data: {
        tenantId: over.tenantId ?? tenantA,
        conversationId: over.conversationId ?? 'conv-1',
        botConfigId: botA,
        specialistId: over.specialistId ?? specA,
        capability: over.capability ?? CAP,
        subjectHash: over.hash ?? hashOf(),
        hashVersion: over.version ?? 2,
        fingerprint: over.fingerprint ?? null,
        consumedAt: over.consumedAt ?? null,
        verdict: over.verdict ?? 'VALID',
        confidence: 0.9,
        fields: { amount: 100 },
        reasonCodes: ['RULES_PASSED'],
        mode: over.mode ?? 'ACTIVE',
        createdAt: over.createdAt ?? new Date(),
        expiresAt: over.expiresAt ?? new Date(Date.now() + 30 * 24 * HOUR_MS),
      },
    });

  const byHash = (
    hash: string,
    conversationId = 'conv-1',
    tenantId = tenantA,
  ) =>
    ledger().checkByHash({
      tenantId,
      capability: CAP,
      conversationId,
      hash: { hash, version: 2 },
    });

  const byFingerprint = (
    fingerprint: string,
    conversationId = 'conv-1',
    tenantId = tenantA,
  ) =>
    ledger().checkByFingerprint({
      tenantId,
      capability: CAP,
      conversationId,
      fingerprint,
    });

  const acceptable = (
    hash: string,
    over: Partial<Parameters<VerificationLedger['findAcceptable']>[0]> = {},
  ) =>
    ledger().findAcceptable({
      tenantId: tenantA,
      conversationId: 'conv-1',
      capability: CAP,
      hash,
      acceptedVerdicts: ['VALID'],
      ...over,
    });

  beforeAll(async () => {
    prisma = createTestPrisma(infra!.databaseUrl);
    for (const id of [tenantA, tenantB]) {
      await prisma.tenant.create({ data: { id, name: id, slug: id } });
    }
    botA = (
      await prisma.botConfig.create({
        data: { tenantId: tenantA, name: 'bot', systemPrompt: 'x' },
      })
    ).id;
    const spec = (tenantId: string) =>
      prisma.specialist
        .create({
          data: {
            tenantId,
            key: 'comprobantes',
            name: 'c',
            capability: CAP,
            status: 'ACTIVE',
            promptTemplate: 'p',
          },
        })
        .then((s) => s.id);
    specA = await spec(tenantA);
    await spec(tenantB);
  });

  afterAll(async () => {
    const tenants = [tenantA, tenantB];
    await prisma.verificationRecord.deleteMany({
      where: { tenantId: { in: tenants } },
    });
    await prisma.botSpecialistBinding.deleteMany({
      where: { tenantId: { in: tenants } },
    });
    await prisma.specialist.deleteMany({
      where: { tenantId: { in: tenants } },
    });
    await prisma.botConfig.deleteMany({ where: { tenantId: { in: tenants } } });
    await prisma.tenant.deleteMany({ where: { id: { in: tenants } } });
    await prisma.$disconnect();
  });

  describe('checkByHash', () => {
    it('sin historial no hay reutilización', async () => {
      expect(await byHash(hashOf())).toEqual({ kind: 'NONE' });
    });

    it('el mismo chat con un resultado reciente usa el caché', async () => {
      const hash = hashOf();
      const saved = await record({ hash });
      const finding = await byHash(hash);
      expect(finding.kind).toBe('CACHED');
      expect(finding.kind !== 'NONE' && finding.record.id).toBe(saved.id);
    });

    it('un resultado más viejo que la vigencia no se reutiliza', async () => {
      const hash = hashOf();
      await record({ hash, createdAt: new Date(Date.now() - 2 * HOUR_MS) });
      expect(await byHash(hash)).toEqual({ kind: 'NONE' });
    });

    it('otro chat del mismo tenant es otro contacto', async () => {
      const hash = hashOf();
      await record({ hash, conversationId: 'conv-otro' });
      expect((await byHash(hash)).kind).toBe('OTHER_CONTACT');
    });

    it('un comprobante consumido es ya usado, aunque sea del mismo chat', async () => {
      const hash = hashOf();
      await record({ hash, consumedAt: new Date() });
      expect((await byHash(hash)).kind).toBe('ALREADY_USED');
    });

    it('lo consumido tiene prioridad sobre lo demás', async () => {
      const hash = hashOf();
      await record({ hash, conversationId: 'conv-otro' });
      await record({ hash, consumedAt: new Date() });
      await record({ hash });
      expect((await byHash(hash)).kind).toBe('ALREADY_USED');
    });

    it('los registros de SHADOW no cuentan', async () => {
      const hash = hashOf();
      await record({ hash, mode: 'SHADOW', consumedAt: new Date() });
      expect(await byHash(hash)).toEqual({ kind: 'NONE' });
    });

    it.each(['ERROR', 'UNREADABLE'] as const)(
      'un resultado %s no cuenta como comprobante usado',
      async (verdict) => {
        const hash = hashOf();
        await record({ hash, verdict, consumedAt: new Date() });
        expect(await byHash(hash)).toEqual({ kind: 'NONE' });
      },
    );

    it('un registro vencido no cuenta', async () => {
      const hash = hashOf();
      await record({
        hash,
        consumedAt: new Date(),
        expiresAt: new Date(Date.now() - HOUR_MS),
      });
      expect(await byHash(hash)).toEqual({ kind: 'NONE' });
    });

    it('un hash de bytes crudos (versión 1) no se compara', async () => {
      const hash = hashOf();
      await record({ hash, version: 1 });
      expect(
        await ledger().checkByHash({
          tenantId: tenantA,
          capability: CAP,
          conversationId: 'conv-1',
          hash: { hash, version: 1 },
        }),
      ).toEqual({ kind: 'NONE' });
    });

    it('no cruza tenants ni capacidades', async () => {
      const hash = hashOf();
      await record({ hash, consumedAt: new Date() });
      expect(await byHash(hash, 'conv-1', tenantB)).toEqual({ kind: 'NONE' });
      expect(
        await ledger().checkByHash({
          tenantId: tenantA,
          capability: 'otra-capacidad',
          conversationId: 'conv-1',
          hash: { hash, version: 2 },
        }),
      ).toEqual({ kind: 'NONE' });
    });
  });

  describe('checkByFingerprint', () => {
    it('el mismo chat sin importar la antigüedad es un reenvío', async () => {
      const fingerprint = `fp-${run}-1`;
      await record({
        fingerprint,
        createdAt: new Date(Date.now() - 48 * HOUR_MS),
      });
      expect((await byFingerprint(fingerprint)).kind).toBe('RESENT');
    });

    it('otro chat es otro contacto y lo consumido es ya usado', async () => {
      const other = `fp-${run}-2`;
      await record({ fingerprint: other, conversationId: 'conv-otro' });
      expect((await byFingerprint(other)).kind).toBe('OTHER_CONTACT');

      const used = `fp-${run}-3`;
      await record({ fingerprint: used, consumedAt: new Date() });
      expect((await byFingerprint(used)).kind).toBe('ALREADY_USED');
    });

    it('detecta el mismo comprobante aunque la imagen tenga otro hash', async () => {
      const fingerprint = `fp-${run}-4`;
      await record({ fingerprint, hash: hashOf() });
      await record({ fingerprint, hash: hashOf(), conversationId: 'conv-x' });
      expect((await byFingerprint(fingerprint, 'conv-nueva')).kind).toBe(
        'OTHER_CONTACT',
      );
    });

    it('no cruza tenants y no ve SHADOW', async () => {
      const fingerprint = `fp-${run}-5`;
      await record({ fingerprint, mode: 'SHADOW' });
      expect(await byFingerprint(fingerprint)).toEqual({ kind: 'NONE' });
      const real = `fp-${run}-6`;
      await record({ fingerprint: real });
      expect(await byFingerprint(real, 'conv-1', tenantB)).toEqual({
        kind: 'NONE',
      });
    });
  });

  describe('findAcceptable', () => {
    it('devuelve el registro vigente, no consumido y con veredicto aceptado', async () => {
      const hash = hashOf();
      const saved = await record({ hash });
      const found = await acceptable(hash);
      expect(found?.id).toBe(saved.id);
      expect(found?.subjectHash).toBe(hash);
    });

    it('un veredicto no aceptado no sirve', async () => {
      const hash = hashOf();
      await record({ hash, verdict: 'NEEDS_REVIEW' });
      expect(await acceptable(hash)).toBeNull();
      expect(
        (
          await acceptable(hash, {
            acceptedVerdicts: ['VALID', 'NEEDS_REVIEW'],
          })
        )?.verdict,
      ).toBe('NEEDS_REVIEW');
    });

    it('un registro de SHADOW nunca autoriza', async () => {
      const hash = hashOf();
      await record({ hash, mode: 'SHADOW' });
      expect(await acceptable(hash)).toBeNull();
    });

    it('uno consumido no sirve', async () => {
      const hash = hashOf();
      await record({ hash, consumedAt: new Date() });
      expect(await acceptable(hash)).toBeNull();
    });

    it('uno fuera de la vigencia del pasaporte no sirve', async () => {
      const hash = hashOf();
      await record({ hash, createdAt: new Date(Date.now() - 2 * HOUR_MS) });
      expect(await acceptable(hash)).toBeNull();
    });

    it('debe ser de esa conversación, tenant, capacidad y hash', async () => {
      const hash = hashOf();
      await record({ hash });
      expect(
        await acceptable(hash, { conversationId: 'conv-otro' }),
      ).toBeNull();
      expect(await acceptable(hash, { tenantId: tenantB })).toBeNull();
      expect(await acceptable(hash, { capability: 'otra' })).toBeNull();
      expect(await acceptable(hashOf())).toBeNull();
    });

    it('un hash de versión 1 no autoriza', async () => {
      const hash = hashOf();
      await record({ hash, version: 1 });
      expect(await acceptable(hash)).toBeNull();
    });

    it('devuelve el más reciente', async () => {
      const hash = hashOf();
      await record({ hash, createdAt: new Date(Date.now() - 10 * 60_000) });
      const newest = await record({ hash });
      expect((await acceptable(hash))?.id).toBe(newest.id);
    });
  });

  describe('claim', () => {
    it('solo el primer reclamo gana', async () => {
      const saved = await record();
      expect(await ledger().claim(saved.id, tenantA)).toBe(true);
      expect(await ledger().claim(saved.id, tenantA)).toBe(false);
    });

    it('con reclamos concurrentes exactamente uno gana', async () => {
      const saved = await record();
      const results = await Promise.all(
        Array.from({ length: 8 }, () => ledger().claim(saved.id, tenantA)),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it('no reclama un registro de otro tenant', async () => {
      const saved = await record();
      expect(await ledger().claim(saved.id, tenantB)).toBe(false);
      expect(
        (
          await prisma.verificationRecord.findUniqueOrThrow({
            where: { id: saved.id },
          })
        ).consumedAt,
      ).toBeNull();
    });

    it('tras reclamar, ya no autoriza y el comprobante cuenta como usado', async () => {
      const hash = hashOf();
      const saved = await record({ hash });
      expect(await acceptable(hash)).not.toBeNull();
      await ledger().claim(saved.id, tenantA);
      expect(await acceptable(hash)).toBeNull();
      expect((await byHash(hash)).kind).toBe('ALREADY_USED');
    });
  });

  describe('flujo completo con el runtime en ACTIVE', () => {
    const response = {
      content: JSON.stringify({
        version: 1,
        confidence: 0.8,
        isExpectedDocument: true,
        fields: {
          amount: 150000,
          currency: 'COP',
          date: '2026-11-08',
          reference: 'TRX-48210377',
          recipient: 'Spa Demo',
          legibility: 'CLEAR',
        },
      }),
      tokensUsed: 10,
      modelUsed: 'm-test',
    };
    const orchestrator = {
      analyzeImageForSpecialist: jest.fn(() => Promise.resolve(response)),
    };
    const runtime = () =>
      new SpecialistRuntime(
        config as never,
        prisma as never,
        orchestrator as never,
        { publish: jest.fn() } as never,
        ledger(),
        {
          resolve: () =>
            Promise.resolve({
              values: {},
              unavailable: [],
              requiredUnavailable: false,
            }),
        } as never,
      );
    let png: Buffer;
    let recompressed: Buffer;

    const go = (conversationId: string, image: Buffer) =>
      runtime().run({
        tenantId: tenantA,
        botConfigId: botA,
        conversationId,
        capability: 'flow-cap',
        image,
      });

    beforeAll(async () => {
      const base = sharp(randomBytes(200 * 200 * 3), {
        raw: { width: 200, height: 200, channels: 3 },
      });
      png = await base.clone().png().toBuffer();
      recompressed = await sharp(png).jpeg({ quality: 70 }).toBuffer();
      const flow = await prisma.specialist.create({
        data: {
          tenantId: tenantA,
          key: 'flujo',
          name: 'flujo',
          capability: 'flow-cap',
          status: 'ACTIVE',
          promptTemplate: 'p',
        },
      });
      await prisma.botSpecialistBinding.create({
        data: {
          tenantId: tenantA,
          botConfigId: botA,
          capability: 'flow-cap',
          specialistId: flow.id,
          mode: 'ACTIVE',
        },
      });
    });

    beforeEach(() => jest.clearAllMocks());

    it('primera vez: llama al modelo, valida y guarda hash versión 2 y huella', async () => {
      const outcome = await go('flow-1', png);
      expect(orchestrator.analyzeImageForSpecialist).toHaveBeenCalledTimes(1);
      expect(outcome.executed && outcome.result.verdict).toBe('VALID');
      const saved = await prisma.verificationRecord.findUniqueOrThrow({
        where: { id: (outcome.executed && outcome.recordId) as string },
      });
      expect(saved.hashVersion).toBe(2);
      expect(saved.fingerprint).toHaveLength(64);
      expect(saved.mode).toBe('ACTIVE');
    });

    it('el mismo archivo en el mismo chat se resuelve desde el caché sin modelo', async () => {
      const outcome = await go('flow-1', png);
      expect(orchestrator.analyzeImageForSpecialist).not.toHaveBeenCalled();
      expect(outcome.executed && outcome.reuse).toBe('CACHED');
    });

    it('el mismo comprobante recomprimido en el mismo chat se detecta por huella', async () => {
      const outcome = await go('flow-1', recompressed);
      expect(orchestrator.analyzeImageForSpecialist).toHaveBeenCalledTimes(1);
      expect(outcome.executed && outcome.reuse).toBe('RESENT');
      expect(outcome.executed && outcome.result.reasonCodes).toContain(
        'RESENT_SAME_RECEIPT',
      );
    });

    it('desde otro chat pide revisión sin llamar al modelo', async () => {
      const outcome = await go('flow-2', png);
      expect(orchestrator.analyzeImageForSpecialist).not.toHaveBeenCalled();
      expect(outcome.executed && outcome.result).toMatchObject({
        verdict: 'NEEDS_REVIEW',
        reasonCodes: ['REUSED_OTHER_CONTACT'],
      });
    });

    it('recomprimido desde otro chat también pide revisión, por huella', async () => {
      const outcome = await go('flow-3', recompressed);
      expect(outcome.executed && outcome.result.verdict).toBe('NEEDS_REVIEW');
      expect(outcome.executed && outcome.result.reasonCodes[0]).toBe(
        'REUSED_OTHER_CONTACT',
      );
    });

    it('una vez consumido, cualquier reenvío es INVALID ya usado', async () => {
      const first = await prisma.verificationRecord.findFirstOrThrow({
        where: {
          tenantId: tenantA,
          conversationId: 'flow-1',
          capability: 'flow-cap',
        },
        orderBy: { createdAt: 'asc' },
      });
      expect(await ledger().claim(first.id, tenantA)).toBe(true);

      for (const [chat, image] of [
        ['flow-1', png],
        ['flow-1', recompressed],
        ['flow-9', png],
        ['flow-9', recompressed],
      ] as const) {
        const outcome = await go(chat, image);
        expect(outcome.executed && outcome.result.verdict).toBe('INVALID');
        expect(outcome.executed && outcome.result.reasonCodes[0]).toBe(
          'ALREADY_USED',
        );
      }
    });
  });
});
