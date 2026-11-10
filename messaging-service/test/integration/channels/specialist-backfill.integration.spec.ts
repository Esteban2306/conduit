import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import {
  DEFAULT_IMAGE_PROMPT,
  backfillSpecialists,
} from 'src/bot/specialists/backfill/backfill-specialists';
import { isolatedInfra } from '../../helpers/isolated-env';
import { createTestPrisma } from '../../helpers/prisma.helper';

const infra = isolatedInfra();
const suite = infra ? describe : describe.skip;

suite('Relleno de especialistas contra la base aislada', () => {
  const run = randomUUID().slice(0, 8);
  const tenantA = `it-a-${run}`;
  const tenantB = `it-b-${run}`;
  let prisma: PrismaClient;
  let botImage: string;
  let botNoImage: string;
  let botOnlyInvalid: string;
  let botOther: string;
  const sealed = 'enc:v1:aaaa:bbbb:cccc';

  const model = (
    botConfigId: string,
    role: 'IMAGE_ANALYSIS' | 'CONVERSATION' | 'FALLBACK',
    extra: Record<string, unknown> = {},
  ) =>
    prisma.aiModelConfig.create({
      data: {
        botConfigId,
        provider: 'ANTHROPIC',
        model: `m-${role}`,
        apiKey: sealed,
        apiKeyLast4: 'wxyz',
        role,
        tier: 'PAID',
        priority: 1,
        tokensUsedToday: 77,
        consecutiveFailures: 3,
        ...extra,
      },
    });

  const options = (apply: boolean, tenantId = tenantA) => ({ apply, tenantId });

  beforeAll(async () => {
    prisma = createTestPrisma(infra!.databaseUrl);
    for (const id of [tenantA, tenantB]) {
      await prisma.tenant.create({ data: { id, name: id, slug: id } });
    }
    const bot = (tenantId: string, name: string, key?: string) =>
      prisma.botConfig
        .create({ data: { tenantId, name, key, systemPrompt: 'x' } })
        .then((b) => b.id);
    botImage = await bot(tenantA, 'Bot Spa', 'bot-spa');
    botNoImage = await bot(tenantA, 'Solo conversación');
    botOnlyInvalid = await bot(tenantA, 'Credencial rota');
    botOther = await bot(tenantB, 'Bot Spa', 'bot-spa');

    await model(botImage, 'IMAGE_ANALYSIS');
    await model(botImage, 'FALLBACK', { priority: 2 });
    await model(botImage, 'CONVERSATION');
    await model(botImage, 'IMAGE_ANALYSIS', { priority: 3, isActive: false });
    await model(botNoImage, 'CONVERSATION');
    await model(botOnlyInvalid, 'IMAGE_ANALYSIS', {
      credentialInvalidAt: new Date(),
    });
    await model(botOther, 'IMAGE_ANALYSIS');
  });

  afterAll(async () => {
    const tenants = [tenantA, tenantB];
    await prisma.botSpecialistBinding.deleteMany({
      where: { tenantId: { in: tenants } },
    });
    await prisma.aiModelConfig.deleteMany({
      where: {
        OR: [
          { specialist: { tenantId: { in: tenants } } },
          { botConfig: { tenantId: { in: tenants } } },
        ],
      },
    });
    await prisma.specialist.deleteMany({
      where: { tenantId: { in: tenants } },
    });
    await prisma.botConfig.deleteMany({ where: { tenantId: { in: tenants } } });
    await prisma.tenant.deleteMany({ where: { id: { in: tenants } } });
    await prisma.$disconnect();
  });

  it('la simulación no escribe nada y muestra lo que haría', async () => {
    const report = await backfillSpecialists(prisma, options(false));

    expect(report.apply).toBe(false);
    expect(report.created.map((c) => c.botConfigId)).toEqual([botImage]);
    expect(report.created[0].models).toBe(2);
    expect(
      await prisma.specialist.count({ where: { tenantId: tenantA } }),
    ).toBe(0);
    expect(
      await prisma.botSpecialistBinding.count({ where: { tenantId: tenantA } }),
    ).toBe(0);
  });

  it('omite el bot cuya única credencial de imagen es inválida', async () => {
    const report = await backfillSpecialists(prisma, options(false));
    expect(report.skipped).toContainEqual({
      botConfigId: botOnlyInvalid,
      reason: 'NO_USABLE_MODEL',
    });
  });

  it('ignora los bots sin modelo de imagen activo', async () => {
    const report = await backfillSpecialists(prisma, options(false));
    expect(report.examined).toBe(2);
    const ids = [...report.created, ...report.skipped].map(
      (x) => x.botConfigId,
    );
    expect(ids).not.toContain(botNoImage);
  });

  it('al aplicar crea el especialista ACTIVE, el vínculo en SHADOW y copia los modelos', async () => {
    const report = await backfillSpecialists(prisma, options(true));

    expect(report.created).toHaveLength(1);
    const entry = report.created[0];
    expect(entry.specialistKey).toBe('bot-spa-imagen');

    const specialist = await prisma.specialist.findUniqueOrThrow({
      where: { id: entry.specialistId },
    });
    expect(specialist).toMatchObject({
      tenantId: tenantA,
      capability: 'image-analysis',
      status: 'ACTIVE',
      promptTemplate: DEFAULT_IMAGE_PROMPT,
    });

    const binding = await prisma.botSpecialistBinding.findFirstOrThrow({
      where: { botConfigId: botImage },
    });
    expect(binding).toMatchObject({
      specialistId: specialist.id,
      capability: 'image-analysis',
      mode: 'SHADOW',
      onFailure: 'DEGRADE',
      timeoutMs: 12000,
    });

    const copies = await prisma.aiModelConfig.findMany({
      where: { specialistId: specialist.id },
      orderBy: { role: 'asc' },
    });
    expect(copies.map((m) => m.role).sort()).toEqual([
      'FALLBACK',
      'IMAGE_ANALYSIS',
    ]);
    for (const copy of copies) {
      expect(copy.botConfigId).toBeNull();
      expect(copy.apiKey).toBe(sealed);
      expect(copy.apiKeyLast4).toBe('wxyz');
      expect(copy.tokensUsedToday).toBe(0);
      expect(copy.consecutiveFailures).toBe(0);
      expect(copy.unavailableUntil).toBeNull();
    }
  });

  it('no copia modelos de conversación ni los inactivos', async () => {
    const copies = await prisma.aiModelConfig.findMany({
      where: { specialist: { tenantId: tenantA } },
    });
    expect(copies.some((m) => m.role === 'CONVERSATION')).toBe(false);
    expect(copies.some((m) => m.isActive === false)).toBe(false);
  });

  it('los modelos originales del bot quedan intactos', async () => {
    const originals = await prisma.aiModelConfig.findMany({
      where: { botConfigId: botImage },
    });
    expect(originals).toHaveLength(4);
    expect(originals.find((m) => m.role === 'CONVERSATION')).toBeDefined();
  });

  it('es idempotente: volver a aplicar no crea nada y reporta ALREADY_BOUND', async () => {
    const before = await prisma.specialist.count({
      where: { tenantId: tenantA },
    });
    const report = await backfillSpecialists(prisma, options(true));

    expect(report.created).toHaveLength(0);
    expect(report.skipped).toContainEqual({
      botConfigId: botImage,
      reason: 'ALREADY_BOUND',
    });
    expect(
      await prisma.specialist.count({ where: { tenantId: tenantA } }),
    ).toBe(before);
  });

  it('con el filtro de tenant no toca los bots de otro tenant', async () => {
    expect(
      await prisma.botSpecialistBinding.count({ where: { tenantId: tenantB } }),
    ).toBe(0);
  });

  it('la misma clave en otro tenant no choca', async () => {
    const report = await backfillSpecialists(prisma, options(true, tenantB));
    expect(report.created[0].specialistKey).toBe('bot-spa-imagen');
  });

  it('si la clave ya existe en el tenant añade un sufijo numérico', async () => {
    const second = await prisma.botConfig.create({
      data: { tenantId: tenantA, name: 'Bot Spa', systemPrompt: 'x' },
    });
    await model(second.id, 'IMAGE_ANALYSIS');

    const report = await backfillSpecialists(prisma, options(true));

    expect(report.created).toHaveLength(1);
    expect(report.created[0].botConfigId).toBe(second.id);
    expect(report.created[0].specialistKey).toBe('bot-spa-imagen-2');
  });

  it('el especialista creado se puede ejecutar: el vínculo cumple las claves compuestas', async () => {
    const binding = await prisma.botSpecialistBinding.findFirstOrThrow({
      where: { botConfigId: botImage },
      include: { specialist: true },
    });
    expect(binding.specialist.tenantId).toBe(binding.tenantId);
    expect(binding.specialist.capability).toBe(binding.capability);
  });
});
