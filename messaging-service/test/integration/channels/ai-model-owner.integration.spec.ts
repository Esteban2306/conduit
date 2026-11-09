import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { isolatedInfra } from '../../helpers/isolated-env';
import { createTestPrisma } from '../../helpers/prisma.helper';

const infra = isolatedInfra();
const suite = infra ? describe : describe.skip;

suite('AiModelConfig: dueño único en la base aislada', () => {
  const tenantId = `it-${randomUUID()}`;
  let prisma: PrismaClient;
  let botId: string;

  const model = (owner: {
    botConfigId?: string | null;
    specialistId?: string | null;
  }) =>
    prisma.aiModelConfig.create({
      data: {
        provider: 'ANTHROPIC',
        model: 'm',
        apiKey: 'k',
        role: 'CONVERSATION',
        tier: 'PAID',
        priority: 1,
        ...owner,
      },
    });

  beforeAll(async () => {
    prisma = createTestPrisma(infra!.databaseUrl);
    await prisma.tenant.create({
      data: { id: tenantId, name: tenantId, slug: tenantId },
    });
    const bot = await prisma.botConfig.create({
      data: { tenantId, name: 'bot', systemPrompt: 'x' },
    });
    botId = bot.id;
  });

  afterAll(async () => {
    await prisma.aiModelConfig.deleteMany({
      where: { OR: [{ botConfigId: botId }, { specialistId: tenantId }] },
    });
    await prisma.botConfig.deleteMany({ where: { tenantId } });
    await prisma.tenant.deleteMany({ where: { id: tenantId } });
    await prisma.$disconnect();
  });

  it('acepta un modelo con dueño bot', async () => {
    await expect(model({ botConfigId: botId })).resolves.toBeDefined();
  });

  it('acepta un modelo con dueño especialista', async () => {
    await expect(model({ specialistId: tenantId })).resolves.toBeDefined();
  });

  it('rechaza un modelo con los dos dueños', async () => {
    await expect(
      model({ botConfigId: botId, specialistId: tenantId }),
    ).rejects.toThrow(/single_owner_check/);
  });

  it('rechaza un modelo sin dueño', async () => {
    await expect(model({})).rejects.toThrow(/single_owner_check/);
  });

  it('no deja borrar un bot que aún tiene modelos (RESTRICT)', async () => {
    await expect(
      prisma.botConfig.delete({ where: { id: botId } }),
    ).rejects.toThrow();
    expect(await prisma.botConfig.count({ where: { id: botId } })).toBe(1);
  });
});
