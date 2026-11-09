jest.mock('@whiskeysockets/baileys', () => ({
  __esModule: true,
  default: jest.fn(),
  DisconnectReason: { loggedOut: 401 },
}));

import { randomBytes, randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { SpecialistRuntime } from 'src/bot/specialists/SpecialistRuntime';
import { VerificationLedger } from 'src/bot/specialists/VerificationLedger';
import { isolatedInfra } from '../../helpers/isolated-env';
import { createTestPrisma } from '../../helpers/prisma.helper';

const infra = isolatedInfra();
const suite = infra ? describe : describe.skip;

const output = (fields: Record<string, unknown> = {}) =>
  JSON.stringify({
    version: 1,
    confidence: 0.7,
    fields: {
      amount: 90000,
      currency: 'COP',
      date: '2026-11-08',
      reference: 'REF-1',
      recipient: 'Spa Demo',
      legibility: 'CLEAR',
      ...fields,
    },
  });

suite('SpecialistRuntime contra la base aislada', () => {
  const run = randomUUID().slice(0, 8);
  const tenantA = `it-a-${run}`;
  const tenantB = `it-b-${run}`;
  const image = randomBytes(512);
  let prisma: PrismaClient;
  let botA: string;
  let specA: string;
  let content = output();
  const orchestrator = {
    analyzeImageForSpecialist: jest.fn(() =>
      Promise.resolve({
        content,
        tokensUsed: 42,
        modelUsed: 'm-test',
        usage: {
          input: 30,
          output: 12,
          cacheRead: 0,
          cacheWrite: 0,
          thinking: 0,
        },
      }),
    ),
  };
  const eventBus = { publish: jest.fn() };

  const config = {
    get: (key: string) =>
      ({
        'specialists.enabled': true,
        'specialists.retentionDays': 30,
        'specialists.passportTtlMinutes': 60,
      })[key],
  };

  const runtime = () =>
    new SpecialistRuntime(
      config as never,
      prisma as never,
      orchestrator as never,
      eventBus as never,
      new VerificationLedger(prisma as never, config as never),
      {
        resolve: () =>
          Promise.resolve({
            values: {},
            unavailable: [],
            requiredUnavailable: false,
          }),
      } as never,
    );

  const execute = (
    tenantId = tenantA,
    legacy?: { valid: boolean; confidence: string },
  ) =>
    runtime().run({
      tenantId,
      botConfigId: botA,
      conversationId: 'conv-1',
      capability: 'payment-proof',
      image,
      legacy,
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
    specA = (
      await prisma.specialist.create({
        data: {
          tenantId: tenantA,
          key: 'comprobantes',
          name: 'Comprobantes',
          capability: 'payment-proof',
          status: 'ACTIVE',
          promptTemplate: 'Comprobantes de pago.',
        },
      })
    ).id;
    await prisma.botSpecialistBinding.create({
      data: {
        tenantId: tenantA,
        botConfigId: botA,
        capability: 'payment-proof',
        specialistId: specA,
        mode: 'SHADOW',
      },
    });
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

  beforeEach(() => {
    content = output();
    jest.clearAllMocks();
  });

  it('ejecuta y guarda un resultado real con todos los campos', async () => {
    const outcome = await execute(tenantA, { valid: true, confidence: 'HIGH' });

    expect(outcome).toMatchObject({ executed: true, mode: 'SHADOW' });
    if (!outcome.executed) return;
    const saved = await prisma.verificationRecord.findUniqueOrThrow({
      where: { id: outcome.recordId as string },
    });
    expect(saved).toMatchObject({
      tenantId: tenantA,
      specialistId: specA,
      capability: 'payment-proof',
      verdict: 'VALID',
      confidence: 0.7,
      modelUsed: 'm-test',
      tokens: 42,
      inputTokens: 30,
      outputTokens: 12,
      mode: 'SHADOW',
      reasonCodes: ['NO_RULES_CONFIGURED'],
      specialistVersion: 1,
    });
    expect(saved.fields).toMatchObject({ amount: 90000, legibility: 'CLEAR' });
    expect(saved.comparison).toEqual({
      legacyValid: true,
      legacyConfidence: 'HIGH',
      agrees: true,
    });
    expect(saved.subjectHash).toHaveLength(64);
    expect(saved.expiresAt.getTime()).toBeGreaterThan(
      Date.now() + 29 * 86_400_000,
    );
  });

  it('sin comparación guarda NULL', async () => {
    const outcome = await execute();
    if (!outcome.executed) throw new Error('no ejecutó');
    const saved = await prisma.verificationRecord.findUniqueOrThrow({
      where: { id: outcome.recordId as string },
    });
    expect(saved.comparison).toBeNull();
  });

  it('un error del modelo también queda guardado como ERROR', async () => {
    content = 'texto libre';
    const outcome = await execute();
    if (!outcome.executed) throw new Error('no ejecutó');
    const saved = await prisma.verificationRecord.findUniqueOrThrow({
      where: { id: outcome.recordId as string },
    });
    expect(saved.verdict).toBe('ERROR');
    expect(saved.reasonCodes).toEqual(['OUTPUT_NOT_JSON']);
    expect(saved.confidence).toBe(0);
  });

  it('el mismo comprobante se puede buscar por tenant y hash', async () => {
    await execute();
    await execute();
    const hash = (
      await prisma.verificationRecord.findFirstOrThrow({
        where: { tenantId: tenantA },
      })
    ).subjectHash;
    expect(
      await prisma.verificationRecord.count({
        where: { tenantId: tenantA, subjectHash: hash },
      }),
    ).toBeGreaterThanOrEqual(2);
    expect(
      await prisma.verificationRecord.count({
        where: { tenantId: tenantB, subjectHash: hash },
      }),
    ).toBe(0);
  });

  it('otro tenant no encuentra el vínculo y no llama al modelo', async () => {
    const outcome = await execute(tenantB);
    expect(outcome).toEqual({ executed: false, reason: 'NO_BINDING' });
    expect(orchestrator.analyzeImageForSpecialist).not.toHaveBeenCalled();
  });

  it('con el especialista inactivo en la base no ejecuta', async () => {
    await prisma.specialist.update({
      where: { id: specA },
      data: { status: 'INACTIVE' },
    });
    try {
      expect(await execute()).toEqual({
        executed: false,
        reason: 'SPECIALIST_INACTIVE',
      });
      expect(await runtime().findMode(tenantA, botA, 'payment-proof')).toBe(
        'OFF',
      );
    } finally {
      await prisma.specialist.update({
        where: { id: specA },
        data: { status: 'ACTIVE' },
      });
    }
  });

  it('findMode devuelve SHADOW para el vínculo activo', async () => {
    expect(await runtime().findMode(tenantA, botA, 'payment-proof')).toBe(
      'SHADOW',
    );
    expect(await runtime().findMode(tenantB, botA, 'payment-proof')).toBe(
      'OFF',
    );
  });
});
