jest.mock('@whiskeysockets/baileys', () => ({
  __esModule: true,
  default: jest.fn(),
  DisconnectReason: { loggedOut: 401 },
}));

import { NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import {
  MIN_SHADOW_SAMPLE,
  SpecialistBindingService,
} from 'src/bot/specialists/admin/SpecialistBindingService';
import { isolatedInfra } from '../../helpers/isolated-env';
import { createTestPrisma } from '../../helpers/prisma.helper';

const infra = isolatedInfra();
const suite = infra ? describe : describe.skip;

const DAY_MS = 86_400_000;
const CAP = 'image-analysis';

suite('Vínculos bot-especialista contra la base aislada', () => {
  const run = randomUUID().slice(0, 8);
  const tenantA = `it-ba-${run}`;
  const tenantB = `it-bb-${run}`;
  let prisma: PrismaClient;
  let service: SpecialistBindingService;
  let counter = 0;

  const bots = {
    findOne: async (botId: string, tenantId: string) => {
      const bot = await prisma.botConfig.findFirst({
        where: { id: botId, tenantId },
      });
      if (!bot) throw new NotFoundException('Bot no encontrado');
      return bot;
    },
  };

  const newBot = (tenantId = tenantA) =>
    prisma.botConfig
      .create({
        data: { tenantId, name: `bot-${++counter}`, systemPrompt: 'x' },
      })
      .then((b) => b.id);

  const rules = [
    { field: 'amount', op: 'gte', ref: { literal: 100000 }, onFail: 'INVALID' },
  ];

  const specialist = async (
    over: {
      tenantId?: string;
      status?: 'ACTIVE' | 'INACTIVE';
      rules?: unknown[];
      models?: 'ninguno' | 'principal' | 'respaldo' | 'invalido' | 'apagado';
      archived?: boolean;
      capability?: string;
    } = {},
  ) => {
    const tenantId = over.tenantId ?? tenantA;
    const id = (
      await prisma.specialist.create({
        data: {
          tenantId,
          key: `esp-${run}-${++counter}`,
          name: 'esp',
          capability: over.capability ?? CAP,
          promptTemplate: 'p',
          status: over.status ?? 'ACTIVE',
          rules: { version: 1, rules: over.rules ?? rules } as never,
          archivedAt: over.archived ? new Date() : null,
        },
      })
    ).id;
    const kind = over.models ?? 'principal';
    if (kind !== 'ninguno') {
      await prisma.aiModelConfig.create({
        data: {
          specialistId: id,
          provider: 'ANTHROPIC',
          model: 'm',
          apiKey: 'enc:v1:x',
          role: kind === 'respaldo' ? 'FALLBACK' : 'IMAGE_ANALYSIS',
          tier: 'PAID',
          priority: 1,
          isActive: kind !== 'apagado',
          credentialInvalidAt: kind === 'invalido' ? new Date() : null,
        },
      });
    }
    return id;
  };

  const put = (
    tenant: string,
    bot: string,
    body: Record<string, unknown>,
    capability = CAP,
  ) => service.upsert(tenant, bot, capability, body);

  const shadowRecords = async (
    specialistId: string,
    botId: string,
    count: number,
    over: {
      agrees?: boolean | null;
      verdict?: 'VALID' | 'ERROR';
      daysAgo?: number;
      tenantId?: string;
    } = {},
  ) => {
    const comparison =
      over.agrees === null || over.agrees === undefined
        ? undefined
        : { legacyValid: true, agrees: over.agrees };
    for (let i = 0; i < count; i++) {
      await prisma.verificationRecord.create({
        data: {
          tenantId: over.tenantId ?? tenantA,
          conversationId: `c-${++counter}`,
          botConfigId: botId,
          specialistId,
          capability: CAP,
          subjectHash: `h-${run}-${++counter}`,
          verdict: over.verdict ?? 'VALID',
          mode: 'SHADOW',
          reasonCodes: [],
          comparison,
          createdAt: new Date(Date.now() - (over.daysAgo ?? 0) * DAY_MS),
          expiresAt: new Date(Date.now() + 30 * DAY_MS),
        },
      });
    }
  };

  beforeAll(async () => {
    prisma = createTestPrisma(infra!.databaseUrl);
    service = new SpecialistBindingService(prisma as never, bots as never);
    for (const id of [tenantA, tenantB]) {
      await prisma.tenant.create({ data: { id, name: id, slug: id } });
    }
  });

  afterAll(async () => {
    const tenants = [tenantA, tenantB];
    await prisma.verificationRecord.deleteMany({
      where: { tenantId: { in: tenants } },
    });
    await prisma.botSpecialistBinding.deleteMany({
      where: { tenantId: { in: tenants } },
    });
    await prisma.aiModelConfig.deleteMany({
      where: { specialist: { tenantId: { in: tenants } } },
    });
    await prisma.specialist.deleteMany({
      where: { tenantId: { in: tenants } },
    });
    await prisma.botConfig.deleteMany({ where: { tenantId: { in: tenants } } });
    await prisma.tenant.deleteMany({ where: { id: { in: tenants } } });
    await prisma.$disconnect();
  });

  describe('crear y cambiar', () => {
    it('crea el vínculo apagado con los valores seguros por defecto', async () => {
      const bot = await newBot();
      const spec = await specialist();
      const { binding, warnings } = await put(tenantA, bot, {
        specialistId: spec,
      });

      expect(binding).toMatchObject({
        botConfigId: bot,
        capability: CAP,
        specialistId: spec,
        mode: 'OFF',
        timeoutMs: 12000,
        onFailure: 'DEGRADE',
      });
      expect(warnings).toEqual([]);
    });

    it('apagar siempre es posible, incluso con el especialista inactivo y sin modelos', async () => {
      const bot = await newBot();
      const spec = await specialist({
        status: 'INACTIVE',
        models: 'ninguno',
        rules: [],
      });
      await expect(
        put(tenantA, bot, { specialistId: spec, mode: 'OFF' }),
      ).resolves.toBeDefined();
    });

    it('cambiar el modo reutiliza la misma fila: un vínculo por bot y capacidad', async () => {
      const bot = await newBot();
      const spec = await specialist();
      await put(tenantA, bot, { specialistId: spec, mode: 'OFF' });
      await put(tenantA, bot, { specialistId: spec, mode: 'SHADOW' });
      const { binding } = await put(tenantA, bot, {
        specialistId: spec,
        mode: 'ACTIVE',
      });

      expect(binding.mode).toBe('ACTIVE');
      expect(
        await prisma.botSpecialistBinding.count({
          where: { botConfigId: bot },
        }),
      ).toBe(1);
    });

    it('cambiar de especialista para la misma capacidad reemplaza el vínculo', async () => {
      const bot = await newBot();
      const first = await specialist();
      const second = await specialist();
      await put(tenantA, bot, { specialistId: first, mode: 'SHADOW' });
      const { binding } = await put(tenantA, bot, {
        specialistId: second,
        mode: 'SHADOW',
      });

      expect(binding.specialistId).toBe(second);
      expect(
        await prisma.botSpecialistBinding.count({
          where: { botConfigId: bot },
        }),
      ).toBe(1);
    });

    it('guarda el timeout y la política de fallo indicados', async () => {
      const bot = await newBot();
      const spec = await specialist();
      const { binding } = await put(tenantA, bot, {
        specialistId: spec,
        mode: 'SHADOW',
        timeoutMs: 5000,
        onFailure: 'BLOCK',
      });
      expect(binding).toMatchObject({ timeoutMs: 5000, onFailure: 'BLOCK' });
    });
  });

  describe('topes para SHADOW', () => {
    it('SHADOW no exige reglas pero sí especialista activo y un modelo utilizable', async () => {
      const bot = await newBot();
      const spec = await specialist({ rules: [] });
      await expect(
        put(tenantA, bot, { specialistId: spec, mode: 'SHADOW' }),
      ).resolves.toBeDefined();
    });

    it('un especialista inactivo se bloquea', async () => {
      const bot = await newBot();
      const spec = await specialist({ status: 'INACTIVE' });
      await expect(
        put(tenantA, bot, { specialistId: spec, mode: 'SHADOW' }),
      ).rejects.toMatchObject({
        status: 409,
        response: {
          details: { blockers: [{ code: 'SPECIALIST_NOT_ACTIVE' }] },
        },
      });
      expect(
        await prisma.botSpecialistBinding.count({
          where: { botConfigId: bot },
        }),
      ).toBe(0);
    });

    it.each(['ninguno', 'invalido', 'apagado'] as const)(
      'sin un modelo utilizable (%s) se bloquea',
      async (models) => {
        const bot = await newBot();
        const spec = await specialist({ models });
        await expect(
          put(tenantA, bot, { specialistId: spec, mode: 'SHADOW' }),
        ).rejects.toMatchObject({
          status: 409,
          response: { details: { blockers: [{ code: 'NO_USABLE_MODEL' }] } },
        });
      },
    );

    it('un modelo de respaldo basta', async () => {
      const bot = await newBot();
      const spec = await specialist({ models: 'respaldo' });
      await expect(
        put(tenantA, bot, { specialistId: spec, mode: 'SHADOW' }),
      ).resolves.toBeDefined();
    });

    it('informa todos los bloqueos juntos', async () => {
      const bot = await newBot();
      const spec = await specialist({
        status: 'INACTIVE',
        models: 'ninguno',
        rules: [],
      });
      let caught:
        | { response: { details: { blockers: Array<{ code: string }> } } }
        | undefined;
      await put(tenantA, bot, { specialistId: spec, mode: 'ACTIVE' }).catch(
        (e) => {
          caught = e as typeof caught;
        },
      );
      expect(
        caught?.response.details.blockers.map((b) => b.code).sort(),
      ).toEqual(['NO_RULES', 'NO_USABLE_MODEL', 'SPECIALIST_NOT_ACTIVE']);
    });
  });

  describe('topes para ACTIVE', () => {
    it('sin reglas se bloquea para que ninguna imagen legible resulte válida', async () => {
      const bot = await newBot();
      const spec = await specialist({ rules: [] });
      await expect(
        put(tenantA, bot, { specialistId: spec, mode: 'ACTIVE' }),
      ).rejects.toMatchObject({
        status: 409,
        response: { details: { blockers: [{ code: 'NO_RULES' }] } },
      });
      expect(
        await prisma.botSpecialistBinding.count({
          where: { botConfigId: bot },
        }),
      ).toBe(0);
    });

    it('con reglas y modelo pasa, y no deja de avisar de la poca muestra', async () => {
      const bot = await newBot();
      const spec = await specialist();
      const { binding, warnings } = await put(tenantA, bot, {
        specialistId: spec,
        mode: 'ACTIVE',
      });

      expect(binding.mode).toBe('ACTIVE');
      expect(warnings).toEqual([
        expect.objectContaining({
          code: 'LOW_SHADOW_SAMPLE',
          count: 0,
          required: MIN_SHADOW_SAMPLE,
        }),
      ]);
    });

    it('el rechazo de un cambio a ACTIVE no altera el vínculo que ya existía', async () => {
      const bot = await newBot();
      const spec = await specialist({ rules: [] });
      await put(tenantA, bot, { specialistId: spec, mode: 'SHADOW' });
      await expect(
        put(tenantA, bot, { specialistId: spec, mode: 'ACTIVE' }),
      ).rejects.toMatchObject({ status: 409 });
      expect(
        (
          await prisma.botSpecialistBinding.findFirstOrThrow({
            where: { botConfigId: bot },
          })
        ).mode,
      ).toBe('SHADOW');
    });
  });

  describe('advertencias con la muestra de SHADOW', () => {
    it('con 20 verificaciones recientes no hay advertencia de muestra', async () => {
      const bot = await newBot();
      const spec = await specialist();
      await shadowRecords(spec, bot, MIN_SHADOW_SAMPLE);
      const { warnings } = await put(tenantA, bot, {
        specialistId: spec,
        mode: 'ACTIVE',
      });
      expect(warnings).toEqual([]);
    });

    it('con 19 sigue avisando', async () => {
      const bot = await newBot();
      const spec = await specialist();
      await shadowRecords(spec, bot, MIN_SHADOW_SAMPLE - 1);
      const { warnings } = await put(tenantA, bot, {
        specialistId: spec,
        mode: 'ACTIVE',
      });
      expect(warnings[0]).toMatchObject({
        code: 'LOW_SHADOW_SAMPLE',
        count: MIN_SHADOW_SAMPLE - 1,
      });
    });

    it('no cuenta los errores, los de hace más de 30 días ni los de otro especialista', async () => {
      const bot = await newBot();
      const spec = await specialist();
      const other = await specialist();
      await shadowRecords(spec, bot, 15);
      await shadowRecords(spec, bot, 10, { verdict: 'ERROR' });
      await shadowRecords(spec, bot, 10, { daysAgo: 40 });
      await shadowRecords(other, bot, 10);
      const { warnings } = await put(tenantA, bot, {
        specialistId: spec,
        mode: 'ACTIVE',
      });
      expect(warnings[0]).toMatchObject({
        code: 'LOW_SHADOW_SAMPLE',
        count: 15,
      });
    });

    it('avisa si coincide poco con el análisis actual', async () => {
      const bot = await newBot();
      const spec = await specialist();
      await shadowRecords(spec, bot, 22, { agrees: false });
      await shadowRecords(spec, bot, 3, { agrees: true });
      const { warnings } = await put(tenantA, bot, {
        specialistId: spec,
        mode: 'ACTIVE',
      });
      expect(warnings.map((w) => w.code)).toEqual(['LOW_SHADOW_AGREEMENT']);
      expect(warnings[0].rate).toBe(0.12);
    });

    it('no avisa de coincidencia con una muestra comparada demasiado pequeña ni si coinciden', async () => {
      const bot = await newBot();
      const spec = await specialist();
      await shadowRecords(spec, bot, 22);
      await shadowRecords(spec, bot, 3, { agrees: false });
      expect(
        (await put(tenantA, bot, { specialistId: spec, mode: 'ACTIVE' }))
          .warnings,
      ).toEqual([]);

      const bot2 = await newBot();
      const spec2 = await specialist();
      await shadowRecords(spec2, bot2, 25, { agrees: true });
      expect(
        (await put(tenantA, bot2, { specialistId: spec2, mode: 'ACTIVE' }))
          .warnings,
      ).toEqual([]);
    });

    it('las advertencias no bloquean el cambio', async () => {
      const bot = await newBot();
      const spec = await specialist();
      await shadowRecords(spec, bot, 22, { agrees: false });
      const { binding } = await put(tenantA, bot, {
        specialistId: spec,
        mode: 'ACTIVE',
      });
      expect(binding.mode).toBe('ACTIVE');
    });

    it('SHADOW no calcula advertencias', async () => {
      const bot = await newBot();
      const spec = await specialist();
      expect(
        (await put(tenantA, bot, { specialistId: spec, mode: 'SHADOW' }))
          .warnings,
      ).toEqual([]);
    });
  });

  describe('validación y aislamiento', () => {
    it('la capacidad del vínculo debe ser la del especialista', async () => {
      const bot = await newBot();
      const spec = await specialist({ capability: 'otra-capacidad' });
      await expect(
        put(tenantA, bot, { specialistId: spec }),
      ).rejects.toMatchObject({
        status: 400,
        response: { details: { binding: CAP, specialist: 'otra-capacidad' } },
      });
    });

    it.each([
      ['capacidad inválida en la ruta', 'Mala Capacidad', { mode: 'OFF' }],
      ['modo desconocido', CAP, { mode: 'FORCE' }],
      ['timeout menor al mínimo', CAP, { timeoutMs: 999 }],
      ['timeout mayor al máximo', CAP, { timeoutMs: 30001 }],
      ['política desconocida', CAP, { onFailure: 'IGNORE' }],
      ['tenant en el cuerpo', CAP, { tenantId: 'otro' }],
      ['capacidad en el cuerpo', CAP, { capability: 'otra' }],
    ])('rechaza %s con 400', async (_name, capability, extra) => {
      const bot = await newBot();
      const spec = await specialist();
      await expect(
        put(tenantA, bot, { specialistId: spec, ...extra }, capability),
      ).rejects.toMatchObject({ status: 400 });
    });

    it('un especialista archivado no se puede vincular', async () => {
      const bot = await newBot();
      const spec = await specialist({ archived: true, status: 'INACTIVE' });
      await expect(
        put(tenantA, bot, { specialistId: spec }),
      ).rejects.toMatchObject({ status: 409 });
    });

    it('el bot o el especialista de otro tenant, o inexistentes, dan 404', async () => {
      const botA = await newBot();
      const botB = await newBot(tenantB);
      const specA = await specialist();
      const specB = await specialist({ tenantId: tenantB });

      await expect(
        put(tenantA, botB, { specialistId: specA }),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        put(tenantA, botA, { specialistId: specB }),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        put(tenantA, botA, { specialistId: randomUUID() }),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        put(tenantA, randomUUID(), { specialistId: specA }),
      ).rejects.toMatchObject({ status: 404 });
      expect(
        await prisma.botSpecialistBinding.count({
          where: { botConfigId: { in: [botA, botB] } },
        }),
      ).toBe(0);
    });
  });

  describe('listar', () => {
    it('devuelve los vínculos del bot con un resumen del especialista', async () => {
      const bot = await newBot();
      const spec = await specialist();
      await put(tenantA, bot, { specialistId: spec, mode: 'SHADOW' });

      const listed = await service.list(tenantA, bot);

      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({
        capability: CAP,
        mode: 'SHADOW',
        specialist: {
          id: spec,
          status: 'ACTIVE',
          version: 1,
          archivedAt: null,
        },
      });
      expect(JSON.stringify(listed)).not.toContain('promptTemplate');
    });

    it('un bot de otro tenant da 404 y uno sin vínculos, lista vacía', async () => {
      const bot = await newBot();
      expect(await service.list(tenantA, bot)).toEqual([]);
      await expect(service.list(tenantB, bot)).rejects.toMatchObject({
        status: 404,
      });
    });
  });

  describe('eliminar', () => {
    it('elimina un vínculo apagado', async () => {
      const bot = await newBot();
      const spec = await specialist();
      await put(tenantA, bot, { specialistId: spec, mode: 'OFF' });
      await service.remove(tenantA, bot, CAP);
      expect(
        await prisma.botSpecialistBinding.count({
          where: { botConfigId: bot },
        }),
      ).toBe(0);
    });

    it.each(['SHADOW', 'ACTIVE'] as const)(
      'un vínculo en %s no se elimina',
      async (mode) => {
        const bot = await newBot();
        const spec = await specialist();
        await put(tenantA, bot, { specialistId: spec, mode });
        await expect(service.remove(tenantA, bot, CAP)).rejects.toMatchObject({
          status: 409,
        });
        expect(
          await prisma.botSpecialistBinding.count({
            where: { botConfigId: bot },
          }),
        ).toBe(1);
      },
    );

    it('un vínculo inexistente o de otro tenant da 404', async () => {
      const bot = await newBot();
      const spec = await specialist();
      await put(tenantA, bot, { specialistId: spec, mode: 'OFF' });
      await expect(
        service.remove(tenantA, bot, 'otra-capacidad'),
      ).rejects.toMatchObject({ status: 404 });
      await expect(service.remove(tenantB, bot, CAP)).rejects.toMatchObject({
        status: 404,
      });
      expect(
        await prisma.botSpecialistBinding.count({
          where: { botConfigId: bot },
        }),
      ).toBe(1);
    });
  });
});
