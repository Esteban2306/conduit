jest.mock('@whiskeysockets/baileys', () => ({
  __esModule: true,
  default: jest.fn(),
  DisconnectReason: { loggedOut: 401 },
}));

import { randomBytes, randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { SpecialistModelService } from 'src/bot/specialists/admin/SpecialistModelService';
import { SecretEncryptionService } from 'src/shared/security/secret-encryption.service';
import { isolatedInfra } from '../../helpers/isolated-env';
import { createTestPrisma } from '../../helpers/prisma.helper';

const infra = isolatedInfra();
const suite = infra ? describe : describe.skip;

suite('Modelos de especialistas contra la base aislada', () => {
  const run = randomUUID().slice(0, 8);
  const tenantA = `it-ma-${run}`;
  const tenantB = `it-mb-${run}`;
  let prisma: PrismaClient;
  let service: SpecialistModelService;
  let counter = 0;
  const probe = jest.fn();

  const encryption = new SecretEncryptionService({
    get: () => randomBytes(32).toString('hex'),
  } as never);
  encryption.onModuleInit();

  const newKey = () => `sk-ant-${randomBytes(20).toString('hex')}`;
  const body = (extra: Record<string, unknown> = {}) => ({
    provider: 'ANTHROPIC',
    model: 'claude-haiku-5-5',
    apiKey: newKey(),
    role: 'IMAGE_ANALYSIS',
    tier: 'PAID',
    priority: 1,
    ...extra,
  });

  const specialist = (tenantId = tenantA, over: Record<string, unknown> = {}) =>
    prisma.specialist
      .create({
        data: {
          tenantId,
          key: `esp-${run}-${++counter}`,
          name: 'esp',
          capability: 'image-analysis',
          promptTemplate: 'p',
          ...over,
        },
      })
      .then((s) => s.id);

  const bind = async (
    specialistId: string,
    mode: 'OFF' | 'SHADOW' | 'ACTIVE',
    capability = 'image-analysis',
  ) => {
    const bot = await prisma.botConfig.create({
      data: { tenantId: tenantA, name: `bot-${++counter}`, systemPrompt: 'x' },
    });
    return prisma.botSpecialistBinding.create({
      data: {
        tenantId: tenantA,
        botConfigId: bot.id,
        capability,
        specialistId,
        mode,
      },
    });
  };

  const add = (
    id: string,
    extra: Record<string, unknown> = {},
    tenant = tenantA,
  ) => service.create(tenant, id, body(extra));

  beforeAll(async () => {
    prisma = createTestPrisma(infra!.databaseUrl);
    service = new SpecialistModelService(prisma as never, encryption, {
      probe,
    } as never);
    for (const id of [tenantA, tenantB]) {
      await prisma.tenant.create({ data: { id, name: id, slug: id } });
    }
  });

  afterAll(async () => {
    const tenants = [tenantA, tenantB];
    await prisma.botSpecialistBinding.deleteMany({
      where: { tenantId: { in: tenants } },
    });
    await prisma.aiModelConfig.deleteMany({
      where: { specialist: { tenantId: { in: tenants } } },
    });
    await prisma.specialistVersion.deleteMany({
      where: { tenantId: { in: tenants } },
    });
    await prisma.specialist.deleteMany({
      where: { tenantId: { in: tenants } },
    });
    await prisma.botConfig.deleteMany({ where: { tenantId: { in: tenants } } });
    await prisma.tenant.deleteMany({ where: { id: { in: tenants } } });
    await prisma.$disconnect();
  });

  beforeEach(() => probe.mockReset());

  describe('alta', () => {
    it('guarda la clave cifrada y devuelve solo datos públicos', async () => {
      const apiKey = newKey();
      const id = await specialist();
      const created = await service.create(tenantA, id, body({ apiKey }));

      expect(created).toMatchObject({
        provider: 'ANTHROPIC',
        model: 'claude-haiku-5-5',
        role: 'IMAGE_ANALYSIS',
        tier: 'PAID',
        isActive: true,
        apiKeyLast4: apiKey.slice(-4),
      });
      expect(JSON.stringify(created)).not.toContain(apiKey);
      expect(created).not.toHaveProperty('apiKey');

      const stored = await prisma.aiModelConfig.findUniqueOrThrow({
        where: { id: created.id },
      });
      expect(stored.apiKey).not.toContain(apiKey);
      expect(stored.apiKey.startsWith('enc:v1:')).toBe(true);
      expect(encryption.open(stored.apiKey)).toBe(apiKey);
      expect(stored).toMatchObject({ specialistId: id, botConfigId: null });
    });

    it('el modelo queda como propio del especialista, nunca del bot', async () => {
      const id = await specialist();
      const created = await add(id);
      const stored = await prisma.aiModelConfig.findUniqueOrThrow({
        where: { id: created.id },
      });
      expect(stored.botConfigId).toBeNull();
    });

    it.each([
      ['rol de conversación', { role: 'CONVERSATION' }],
      ['clave de relleno', { apiKey: 'YOUR_API_KEY_HERE_0000000000' }],
      ['clave corta', { apiKey: 'corta' }],
      ['CUSTOM sin baseUrl', { provider: 'CUSTOM' }],
      ['dueño enviado por el cliente', { botConfigId: 'otro' }],
      ['especialista enviado por el cliente', { specialistId: 'otro' }],
    ])('rechaza %s con 400 y no guarda nada', async (_name, extra) => {
      const id = await specialist();
      await expect(add(id, extra)).rejects.toMatchObject({ status: 400 });
      expect(
        await prisma.aiModelConfig.count({ where: { specialistId: id } }),
      ).toBe(0);
    });

    it('un especialista de otro tenant o inexistente es 404', async () => {
      const mine = await specialist();
      await expect(add(mine, {}, tenantB)).rejects.toMatchObject({
        status: 404,
      });
      await expect(add(randomUUID())).rejects.toMatchObject({ status: 404 });
    });

    it('un especialista archivado no admite modelos', async () => {
      const id = await specialist(tenantA, { archivedAt: new Date() });
      await expect(add(id)).rejects.toMatchObject({ status: 409 });
    });
  });

  describe('listado', () => {
    it('ordena por rol y prioridad y nunca incluye la clave', async () => {
      const id = await specialist();
      await add(id, { role: 'FALLBACK', priority: 1 });
      await add(id, { role: 'IMAGE_ANALYSIS', priority: 2 });
      await add(id, { role: 'IMAGE_ANALYSIS', priority: 1 });

      const listed = await service.list(tenantA, id);

      expect(listed.map((m) => `${m.role}:${m.priority}`)).toEqual([
        'IMAGE_ANALYSIS:1',
        'IMAGE_ANALYSIS:2',
        'FALLBACK:1',
      ]);
      expect(JSON.stringify(listed)).not.toMatch(/sk-ant-/);
      for (const model of listed) expect(model).not.toHaveProperty('apiKey');
    });

    it('otro tenant recibe 404 y no ve los modelos', async () => {
      const id = await specialist();
      await add(id);
      await expect(service.list(tenantB, id)).rejects.toMatchObject({
        status: 404,
      });
    });

    it('no mezcla los modelos de dos especialistas', async () => {
      const a = await specialist();
      const b = await specialist();
      await add(a);
      await add(b);
      await add(b, { priority: 2 });
      expect(await service.list(tenantA, a)).toHaveLength(1);
      expect(await service.list(tenantA, b)).toHaveLength(2);
    });
  });

  describe('edición y rotación de clave', () => {
    it('rotar la clave la vuelve a cifrar, actualiza los últimos 4 y limpia el estado de fallos', async () => {
      const id = await specialist();
      const model = await add(id);
      await prisma.aiModelConfig.update({
        where: { id: model.id },
        data: {
          credentialInvalidAt: new Date(),
          consecutiveFailures: 4,
          unavailableUntil: new Date(Date.now() + 60_000),
          lastErrorType: 'AUTH',
        },
      });

      const rotated = newKey();
      const updated = await service.update(tenantA, id, model.id, {
        apiKey: rotated,
      });

      expect(updated).toMatchObject({
        apiKeyLast4: rotated.slice(-4),
        credentialInvalidAt: null,
        consecutiveFailures: 0,
        unavailableUntil: null,
        lastErrorType: null,
      });
      expect(JSON.stringify(updated)).not.toContain(rotated);
      const stored = await prisma.aiModelConfig.findUniqueOrThrow({
        where: { id: model.id },
      });
      expect(encryption.open(stored.apiKey)).toBe(rotated);
    });

    it('cambiar solo la prioridad no toca la clave ni el estado', async () => {
      const id = await specialist();
      const model = await add(id);
      const before = await prisma.aiModelConfig.findUniqueOrThrow({
        where: { id: model.id },
      });
      await prisma.aiModelConfig.update({
        where: { id: model.id },
        data: { consecutiveFailures: 2 },
      });

      const updated = await service.update(tenantA, id, model.id, {
        priority: 9,
        tier: 'FREE',
      });

      expect(updated).toMatchObject({
        priority: 9,
        tier: 'FREE',
        consecutiveFailures: 2,
      });
      const after = await prisma.aiModelConfig.findUniqueOrThrow({
        where: { id: model.id },
      });
      expect(after.apiKey).toBe(before.apiKey);
    });

    it('permite limpiar límites con null', async () => {
      const id = await specialist();
      const model = await add(id, {
        dailyTokenLimit: 1000,
        minuteRequestLimit: 10,
      });
      const updated = await service.update(tenantA, id, model.id, {
        dailyTokenLimit: null,
        minuteRequestLimit: null,
      });
      expect(updated).toMatchObject({
        dailyTokenLimit: null,
        minuteRequestLimit: null,
      });
    });

    it.each([
      ['cuerpo vacío', {}],
      ['proveedor (inmutable)', { provider: 'OPENAI' }],
      ['clave de relleno', { apiKey: 'YOUR_API_KEY_HERE_0000000000' }],
      ['dueño', { specialistId: 'otro' }],
    ])('rechaza %s', async (_name, change) => {
      const id = await specialist();
      const model = await add(id);
      await expect(
        service.update(tenantA, id, model.id, change),
      ).rejects.toMatchObject({
        status: 400,
      });
    });

    it('un modelo de otro especialista, de otro tenant o inexistente es 404', async () => {
      const a = await specialist();
      const b = await specialist();
      const other = await add(b);
      await expect(
        service.update(tenantA, a, other.id, { priority: 2 }),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        service.update(tenantB, a, other.id, { priority: 2 }),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        service.update(tenantA, a, randomUUID(), { priority: 2 }),
      ).rejects.toMatchObject({ status: 404 });
      expect(
        (
          await prisma.aiModelConfig.findUniqueOrThrow({
            where: { id: other.id },
          })
        ).priority,
      ).toBe(1);
    });
  });

  describe('topes: nunca dejar sin modelo a un especialista en uso', () => {
    it('desactivar el único modelo con un vínculo en SHADOW responde 409 y no cambia nada', async () => {
      const id = await specialist();
      const model = await add(id);
      const binding = await bind(id, 'SHADOW');

      await expect(
        service.update(tenantA, id, model.id, { isActive: false }),
      ).rejects.toMatchObject({
        status: 409,
        response: {
          details: {
            bindings: [{ botConfigId: binding.botConfigId, mode: 'SHADOW' }],
          },
        },
      });
      expect(
        (
          await prisma.aiModelConfig.findUniqueOrThrow({
            where: { id: model.id },
          })
        ).isActive,
      ).toBe(true);
    });

    it('eliminar el único modelo con un vínculo ACTIVE responde 409 y lo conserva', async () => {
      const id = await specialist();
      const model = await add(id);
      await bind(id, 'ACTIVE');
      await expect(service.remove(tenantA, id, model.id)).rejects.toMatchObject(
        { status: 409 },
      );
      expect(
        await prisma.aiModelConfig.count({ where: { id: model.id } }),
      ).toBe(1);
    });

    it('con otro modelo utilizable sí se puede desactivar o eliminar', async () => {
      const id = await specialist();
      const first = await add(id);
      await add(id, { priority: 2 });
      await bind(id, 'ACTIVE');

      await expect(
        service.update(tenantA, id, first.id, { isActive: false }),
      ).resolves.toBeDefined();
      const second = (await service.list(tenantA, id)).find(
        (m) => m.priority === 2,
      );
      await expect(
        service.remove(tenantA, id, second!.id),
      ).rejects.toMatchObject({ status: 409 });
    });

    it('un modelo de respaldo cuenta como utilizable', async () => {
      const id = await specialist();
      const primary = await add(id);
      await add(id, { role: 'FALLBACK', priority: 5 });
      await bind(id, 'SHADOW');
      await expect(
        service.remove(tenantA, id, primary.id),
      ).resolves.toBeDefined();
    });

    it('con el vínculo apagado o sin vínculos se puede eliminar el último modelo', async () => {
      const off = await specialist();
      const offModel = await add(off);
      await bind(off, 'OFF');
      await expect(
        service.remove(tenantA, off, offModel.id),
      ).resolves.toBeDefined();

      const free = await specialist();
      const freeModel = await add(free);
      await expect(
        service.update(tenantA, free, freeModel.id, { isActive: false }),
      ).resolves.toBeDefined();
    });

    it('un modelo con la credencial inválida no cuenta como utilizable', async () => {
      const id = await specialist();
      const good = await add(id);
      const bad = await add(id, { priority: 2 });
      await prisma.aiModelConfig.update({
        where: { id: bad.id },
        data: { credentialInvalidAt: new Date() },
      });
      await bind(id, 'ACTIVE');
      await expect(service.remove(tenantA, id, good.id)).rejects.toMatchObject({
        status: 409,
      });
    });
  });

  describe('reactivar con prueba', () => {
    it('limpia el estado, prueba el modelo con su fila completa y confirma', async () => {
      probe.mockResolvedValue({ ok: true });
      const id = await specialist();
      const model = await add(id);
      await prisma.aiModelConfig.update({
        where: { id: model.id },
        data: {
          credentialInvalidAt: new Date(),
          consecutiveFailures: 3,
          tokensUsedToday: 500,
          unavailableUntil: new Date(Date.now() + 60_000),
        },
      });

      const result = await service.reactivate(tenantA, id, model.id);

      expect(result).toMatchObject({
        credentialInvalidAt: null,
        consecutiveFailures: 0,
        tokensUsedToday: 0,
        unavailableUntil: null,
        reactivation: { ok: true },
      });
      expect(probe).toHaveBeenCalledTimes(1);
      const [probed] = probe.mock.calls[0] as [
        { id: string; specialistId: string; apiKey: string },
      ];
      expect(probed).toMatchObject({ id: model.id, specialistId: id });
      expect(probed.apiKey.startsWith('enc:v1:')).toBe(true);
      expect(JSON.stringify(result)).not.toContain(probed.apiKey);
    });

    it('si la prueba falla informa el motivo sin revelar claves', async () => {
      const leaked = newKey();
      probe.mockResolvedValue({
        ok: false,
        error: { type: 'AUTH', message: `401 con la clave ${leaked}` },
      });
      const id = await specialist();
      const model = await add(id);

      const result = await service.reactivate(tenantA, id, model.id);

      expect(result.reactivation).toMatchObject({
        ok: false,
        errorType: 'AUTH',
      });
      expect(JSON.stringify(result)).not.toContain(leaked);
    });

    it('otro tenant o un modelo ajeno es 404 y no se prueba nada', async () => {
      const a = await specialist();
      const b = await specialist();
      const model = await add(b);
      await expect(
        service.reactivate(tenantB, b, model.id),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        service.reactivate(tenantA, a, model.id),
      ).rejects.toMatchObject({ status: 404 });
      expect(probe).not.toHaveBeenCalled();
    });
  });

  describe('eliminar', () => {
    it('elimina el modelo y devuelve datos públicos', async () => {
      const id = await specialist();
      const model = await add(id);
      const removed = await service.remove(tenantA, id, model.id);
      expect(removed.id).toBe(model.id);
      expect(removed).not.toHaveProperty('apiKey');
      expect(
        await prisma.aiModelConfig.count({ where: { id: model.id } }),
      ).toBe(0);
    });
  });
});
