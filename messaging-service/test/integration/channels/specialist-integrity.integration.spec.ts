import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { isolatedInfra } from '../../helpers/isolated-env';
import { createTestPrisma } from '../../helpers/prisma.helper';

const infra = isolatedInfra();
const suite = infra ? describe : describe.skip;

suite(
  'Specialist y BotSpecialistBinding: integridad en la base aislada',
  () => {
    const run = randomUUID().slice(0, 8);
    const tenantA = `it-a-${run}`;
    const tenantB = `it-b-${run}`;
    let prisma: PrismaClient;
    let botA: string;
    let specA: string;
    let specB: string;

    const specialist = (
      tenantId: string,
      key: string,
      capability = 'payment-proof',
    ) =>
      prisma.specialist.create({
        data: { tenantId, key, name: key, capability, promptTemplate: 'p' },
      });

    const bind = (data: {
      tenantId: string;
      botConfigId: string;
      capability: string;
      specialistId: string;
    }) => prisma.botSpecialistBinding.create({ data });

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
      specA = (await specialist(tenantA, 'comprobantes')).id;
      specB = (await specialist(tenantB, 'comprobantes')).id;
    });

    afterAll(async () => {
      const tenants = [tenantA, tenantB];
      await prisma.aiModelConfig.deleteMany({
        where: { specialist: { tenantId: { in: tenants } } },
      });
      await prisma.botSpecialistBinding.deleteMany({
        where: { tenantId: { in: tenants } },
      });
      await prisma.specialist.deleteMany({
        where: { tenantId: { in: tenants } },
      });
      await prisma.botConfig.deleteMany({
        where: { tenantId: { in: tenants } },
      });
      await prisma.tenant.deleteMany({ where: { id: { in: tenants } } });
      await prisma.$disconnect();
    });

    it('crea el especialista con los valores seguros por defecto', async () => {
      const saved = await prisma.specialist.findUniqueOrThrow({
        where: { id: specA },
      });
      expect(saved.status).toBe('INACTIVE');
      expect(saved.rules).toEqual({ version: 1, rules: [] });
      expect(saved.contextSources).toEqual({ version: 1, sources: [] });
      expect(saved.outputVersion).toBe(1);
    });

    it('la clave es única por tenant, pero se puede repetir en otro tenant', async () => {
      await expect(specialist(tenantA, 'comprobantes')).rejects.toThrow();
      expect(specB).toBeDefined();
    });

    it('un vínculo válido nace apagado y con degradación', async () => {
      const binding = await bind({
        tenantId: tenantA,
        botConfigId: botA,
        capability: 'payment-proof',
        specialistId: specA,
      });
      expect(binding.mode).toBe('OFF');
      expect(binding.onFailure).toBe('DEGRADE');
      expect(binding.timeoutMs).toBe(12000);
    });

    it('un bot solo puede tener un vínculo por capacidad', async () => {
      const otro = await specialist(tenantA, 'otro-comprobante');
      await expect(
        bind({
          tenantId: tenantA,
          botConfigId: botA,
          capability: 'payment-proof',
          specialistId: otro.id,
        }),
      ).rejects.toThrow();
    });

    it('rechaza vincular un bot con un especialista de otro tenant', async () => {
      const lonely = await prisma.botConfig.create({
        data: { tenantId: tenantA, name: 'solo', systemPrompt: 'x' },
      });
      await expect(
        bind({
          tenantId: tenantA,
          botConfigId: lonely.id,
          capability: 'payment-proof',
          specialistId: specB,
        }),
      ).rejects.toThrow(/foreign key/i);
    });

    it('rechaza un vínculo cuyo tenant no es el del bot', async () => {
      const lonely = await prisma.botConfig.create({
        data: { tenantId: tenantA, name: 'solo2', systemPrompt: 'x' },
      });
      await expect(
        bind({
          tenantId: tenantB,
          botConfigId: lonely.id,
          capability: 'payment-proof',
          specialistId: specB,
        }),
      ).rejects.toThrow(/foreign key/i);
    });

    it('rechaza un vínculo con una capacidad distinta a la del especialista', async () => {
      const lonely = await prisma.botConfig.create({
        data: { tenantId: tenantA, name: 'solo3', systemPrompt: 'x' },
      });
      await expect(
        bind({
          tenantId: tenantA,
          botConfigId: lonely.id,
          capability: 'identity-check',
          specialistId: specA,
        }),
      ).rejects.toThrow(/foreign key/i);
    });

    it('no deja borrar un especialista con vínculos', async () => {
      await expect(
        prisma.specialist.delete({ where: { id: specA } }),
      ).rejects.toThrow();
    });

    it('no deja borrar un especialista con modelos propios', async () => {
      const owner = await specialist(tenantB, 'con-modelo', 'other-cap');
      await prisma.aiModelConfig.create({
        data: {
          specialistId: owner.id,
          provider: 'ANTHROPIC',
          model: 'm',
          apiKey: 'k',
          role: 'IMAGE_ANALYSIS',
          tier: 'PAID',
          priority: 1,
        },
      });
      await expect(
        prisma.specialist.delete({ where: { id: owner.id } }),
      ).rejects.toThrow();
    });

    it('un modelo no puede apuntar a un especialista inexistente', async () => {
      await expect(
        prisma.aiModelConfig.create({
          data: {
            specialistId: randomUUID(),
            provider: 'ANTHROPIC',
            model: 'm',
            apiKey: 'k',
            role: 'IMAGE_ANALYSIS',
            tier: 'PAID',
            priority: 1,
          },
        }),
      ).rejects.toThrow();
    });

    it('no deja borrar un bot con vínculos', async () => {
      await expect(
        prisma.botConfig.delete({ where: { id: botA } }),
      ).rejects.toThrow();
    });
  },
);
