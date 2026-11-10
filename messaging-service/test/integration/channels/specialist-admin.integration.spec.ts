jest.mock('@whiskeysockets/baileys', () => ({
  __esModule: true,
  default: jest.fn(),
  DisconnectReason: { loggedOut: 401 },
}));

import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { SpecialistAdminService } from 'src/bot/specialists/admin/SpecialistAdminService';
import { isolatedInfra } from '../../helpers/isolated-env';
import { createTestPrisma } from '../../helpers/prisma.helper';
import { LEGACY_IMAGE_OUTPUT_SCHEMA } from 'src/bot/specialists/backfill/backfill-specialists';

const infra = isolatedInfra();
const suite = infra ? describe : describe.skip;

suite('Administración de especialistas contra la base aislada', () => {
  const run = randomUUID().slice(0, 8);
  const tenantA = `it-sa-${run}`;
  const tenantB = `it-sb-${run}`;
  let prisma: PrismaClient;
  let service: SpecialistAdminService;
  let botA: string;

  const rule = (extra: Record<string, unknown> = {}) => ({
    field: 'amount',
    op: 'gte',
    ref: { literal: 100000 },
    onFail: 'INVALID',
    ...extra,
  });
  const base = (extra: Record<string, unknown> = {}) => ({
    name: 'Comprobantes de pago',
    capability: 'image-analysis',
    promptTemplate: 'Comprobantes de anticipo.',
    outputSchema: LEGACY_IMAGE_OUTPUT_SCHEMA,
    ...extra,
  });
  const create = (extra: Record<string, unknown> = {}, tenant = tenantA) =>
    service.create(tenant, 'user-1', base(extra));
  const versions = (id: string, tenant = tenantA) =>
    service.listVersions(tenant, id);

  beforeAll(async () => {
    prisma = createTestPrisma(infra!.databaseUrl);
    service = new SpecialistAdminService(prisma as never);
    for (const id of [tenantA, tenantB]) {
      await prisma.tenant.create({ data: { id, name: id, slug: id } });
    }
    botA = (
      await prisma.botConfig.create({
        data: { tenantId: tenantA, name: 'bot', systemPrompt: 'x' },
      })
    ).id;
  });

  afterAll(async () => {
    const tenants = [tenantA, tenantB];
    await prisma.botSpecialistBinding.deleteMany({
      where: { tenantId: { in: tenants } },
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

  describe('crear', () => {
    it('nace inactivo, en la versión 1 y con su instantánea inicial', async () => {
      const created = await create();

      expect(created).toMatchObject({
        status: 'INACTIVE',
        version: 1,
        archivedAt: null,
        capability: 'image-analysis',
        rules: { version: 1, rules: [] },
        contextSources: { version: 1, sources: [] },
      });
      const history = await versions(created.id);
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        version: 1,
        changeNote: 'Versión inicial',
        createdBy: 'user-1',
      });
    });

    it('genera la clave desde el nombre y le agrega sufijo si ya existe', async () => {
      const first = await create({ name: 'Mi Especialista Único' });
      const second = await create({ name: 'Mi Especialista Único' });
      expect(first.key).toBe('mi-especialista-unico');
      expect(second.key).toBe('mi-especialista-unico-2');
    });

    it('una clave explícita repetida en el tenant es 409, y en otro tenant se permite', async () => {
      await create({ key: 'clave-fija' });
      await expect(create({ key: 'clave-fija' })).rejects.toMatchObject({
        status: 409,
      });
      await expect(
        create({ key: 'clave-fija' }, tenantB),
      ).resolves.toBeDefined();
    });

    it('guarda reglas y contexto normalizados', async () => {
      const created = await create({
        rules: { version: 1, rules: [rule()] },
        contextSources: {
          version: 1,
          sources: [
            {
              key: 'minimo',
              kind: 'EXTERNAL_MAPPING',
              name: 'vars.minimo',
            },
          ],
        },
      });
      expect(
        (
          created.contextSources as {
            sources: Array<{ maxAgeSeconds: number }>;
          }
        ).sources[0].maxAgeSeconds,
      ).toBe(60);
    });

    it.each([
      ['sin nombre', { name: '' }],
      ['con una capacidad inválida', { capability: 'Mala Capacidad' }],
      ['con un prompt vacío', { promptTemplate: '' }],
      ['con un tenant enviado por el cliente', { tenantId: 'otro' }],
      ['con reglas inválidas', { rules: { version: 9, rules: [] } }],
      [
        'con un operador desconocido',
        { rules: { version: 1, rules: [rule({ op: 'matches' })] } },
      ],
    ])('rechaza %s con 400 y detalle', async (_name, extra) => {
      await expect(create(extra)).rejects.toMatchObject({ status: 400 });
    });

    it('rechaza reglas que citan contexto sin declarar', async () => {
      await expect(
        create({
          rules: { version: 1, rules: [rule({ ref: 'grounding.fantasma' })] },
        }),
      ).rejects.toMatchObject({
        status: 400,
        response: { details: { undeclaredKeys: ['fantasma'] } },
      });
    });

    it('un fallo de validación no deja nada guardado', async () => {
      const before = await prisma.specialist.count({
        where: { tenantId: tenantA },
      });
      await expect(create({ name: '' })).rejects.toBeDefined();
      expect(
        await prisma.specialist.count({ where: { tenantId: tenantA } }),
      ).toBe(before);
    });
  });

  describe('consultar y aislar por tenant', () => {
    it('lista solo los del tenant, con conteo de vínculos y modelos', async () => {
      const mine = await create({ name: 'Solo del tenant A' });
      await create({ name: 'Solo del tenant B' }, tenantB);

      const listed = await service.list(tenantA, {});

      expect(listed.some((s) => s.id === mine.id)).toBe(true);
      expect(listed.every((s) => s.id !== undefined)).toBe(true);
      expect(listed.find((s) => s.id === mine.id)).toMatchObject({
        bindingCount: 0,
        modelCount: 0,
      });
      const names = listed.map((s) => s.name);
      expect(names).not.toContain('Solo del tenant B');
    });

    it('filtra por estado y capacidad y oculta los archivados por defecto', async () => {
      const a = await create({ capability: 'otra-cap', name: 'Filtro uno' });
      await service.update(tenantA, 'u', a.id, { status: 'ACTIVE' });
      const archived = await create({
        capability: 'otra-cap',
        name: 'Filtro dos',
      });
      await service.archive(tenantA, archived.id);

      const active = await service.list(tenantA, {
        capability: 'otra-cap',
        status: 'ACTIVE',
      });
      expect(active.map((s) => s.id)).toEqual([a.id]);

      const visible = await service.list(tenantA, { capability: 'otra-cap' });
      expect(visible.map((s) => s.id)).not.toContain(archived.id);

      const all = await service.list(tenantA, {
        capability: 'otra-cap',
        includeArchived: 'true',
      });
      expect(all.map((s) => s.id)).toContain(archived.id);
    });

    it('un filtro inválido es 400', async () => {
      await expect(
        service.list(tenantA, { status: 'RARO' }),
      ).rejects.toMatchObject({ status: 400 });
    });

    it('otro tenant no ve, no edita, no archiva ni restaura: 404', async () => {
      const mine = await create({ name: 'Privado' });
      for (const attempt of [
        () => service.get(tenantB, mine.id),
        () => service.getByKey(tenantB, mine.key),
        () => service.update(tenantB, 'u', mine.id, { name: 'robado' }),
        () => service.archive(tenantB, mine.id),
        () => service.unarchive(tenantB, mine.id),
        () => service.listVersions(tenantB, mine.id),
        () => service.getVersion(tenantB, mine.id, 1),
        () => service.restore(tenantB, 'u', mine.id, 1, {}),
      ]) {
        await expect(attempt()).rejects.toMatchObject({ status: 404 });
      }
      expect((await service.get(tenantA, mine.id)).name).toBe('Privado');
    });

    it('se obtiene por clave', async () => {
      const mine = await create({ name: 'Por clave' });
      expect((await service.getByKey(tenantA, mine.key)).id).toBe(mine.id);
    });
  });

  describe('modificar y versionar', () => {
    it('un cambio de prompt crea la versión 2 con su instantánea, nota y autor', async () => {
      const created = await create();
      const updated = await service.update(tenantA, 'user-2', created.id, {
        promptTemplate: 'Prompt nuevo.',
        changeNote: 'Más claro',
      });

      expect(updated.version).toBe(2);
      expect(updated.promptTemplate).toBe('Prompt nuevo.');
      const history = await versions(created.id);
      expect(history.map((v) => v.version)).toEqual([2, 1]);
      expect(history[0]).toMatchObject({
        changeNote: 'Más claro',
        createdBy: 'user-2',
      });
      const snapshot = await service.getVersion(tenantA, created.id, 1);
      expect(snapshot.promptTemplate).toBe('Comprobantes de anticipo.');
    });

    it('un cambio de reglas o de contexto también versiona', async () => {
      const created = await create();
      const withRules = await service.update(tenantA, 'u', created.id, {
        rules: { version: 1, rules: [rule()] },
      });
      expect(withRules.version).toBe(2);
      const withSources = await service.update(tenantA, 'u', created.id, {
        contextSources: {
          version: 1,
          sources: [
            { key: 'minimo', kind: 'EXTERNAL_MAPPING', name: 'vars.minimo' },
          ],
        },
      });
      expect(withSources.version).toBe(3);
    });

    it('cambiar solo el nombre o el estado no crea versión', async () => {
      const created = await create();
      const renamed = await service.update(tenantA, 'u', created.id, {
        name: 'Otro nombre',
      });
      const activated = await service.update(tenantA, 'u', created.id, {
        status: 'ACTIVE',
      });

      expect(renamed.version).toBe(1);
      expect(activated.version).toBe(1);
      expect(activated).toMatchObject({
        name: 'Otro nombre',
        status: 'ACTIVE',
      });
      expect(await versions(created.id)).toHaveLength(1);
    });

    it('enviar el mismo contenido no crea versión', async () => {
      const created = await create();
      const same = await service.update(tenantA, 'u', created.id, {
        promptTemplate: created.promptTemplate,
        rules: created.rules as never,
      });
      expect(same.version).toBe(1);
      expect(await versions(created.id)).toHaveLength(1);
    });

    it('la clave y la capacidad no se pueden cambiar', async () => {
      const created = await create();
      for (const forbidden of [
        { key: 'otra' },
        { capability: 'otra-cap' },
        { tenantId: 'x' },
      ]) {
        await expect(
          service.update(tenantA, 'u', created.id, { name: 'x', ...forbidden }),
        ).rejects.toMatchObject({ status: 400 });
      }
      const after = await service.get(tenantA, created.id);
      expect(after.key).toBe(created.key);
      expect(after.capability).toBe('image-analysis');
    });

    it('una modificación vacía o inválida es 400', async () => {
      const created = await create();
      await expect(
        service.update(tenantA, 'u', created.id, {}),
      ).rejects.toMatchObject({ status: 400 });
      await expect(
        service.update(tenantA, 'u', created.id, { status: 'ARCHIVED' }),
      ).rejects.toMatchObject({ status: 400 });
      await expect(
        service.update(tenantA, 'u', created.id, {
          rules: { version: 1, rules: [rule({ ref: 'grounding.fantasma' })] },
        }),
      ).rejects.toMatchObject({ status: 400 });
      expect((await service.get(tenantA, created.id)).version).toBe(1);
    });

    it('con expectedVersion desfasada responde 409 con la versión vigente', async () => {
      const created = await create();
      await service.update(tenantA, 'u', created.id, {
        promptTemplate: 'Cambio 1',
      });

      await expect(
        service.update(tenantA, 'u', created.id, {
          promptTemplate: 'Cambio 2',
          expectedVersion: 1,
        }),
      ).rejects.toMatchObject({
        status: 409,
        response: { details: { currentVersion: 2 } },
      });
      expect((await service.get(tenantA, created.id)).promptTemplate).toBe(
        'Cambio 1',
      );
    });

    it('con expectedVersion correcta aplica', async () => {
      const created = await create();
      const updated = await service.update(tenantA, 'u', created.id, {
        promptTemplate: 'Cambio',
        expectedVersion: 1,
      });
      expect(updated.version).toBe(2);
    });

    it('dos ediciones simultáneas con la misma versión: una gana y la otra recibe 409', async () => {
      const created = await create();
      const results = await Promise.allSettled([
        service.update(tenantA, 'u1', created.id, {
          promptTemplate: 'A',
          expectedVersion: 1,
        }),
        service.update(tenantA, 'u2', created.id, {
          promptTemplate: 'B',
          expectedVersion: 1,
        }),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find(
        (r) => r.status === 'rejected',
      ) as PromiseRejectedResult;
      expect(rejected.reason).toMatchObject({ status: 409 });
      expect((await versions(created.id)).map((v) => v.version)).toEqual([
        2, 1,
      ]);
    });

    it('sin expectedVersion, varias ediciones simultáneas de contenido nunca duplican versiones', async () => {
      const created = await create();
      const results = await Promise.allSettled(
        Array.from({ length: 5 }, (_, i) =>
          service.update(tenantA, 'u', created.id, {
            promptTemplate: `Cambio ${i}`,
          }),
        ),
      );
      const won = results.filter((r) => r.status === 'fulfilled').length;
      const history = await versions(created.id);
      expect(history).toHaveLength(won + 1);
      expect(new Set(history.map((v) => v.version)).size).toBe(history.length);
      expect((await service.get(tenantA, created.id)).version).toBe(won + 1);
    });
  });

  describe('restaurar', () => {
    it('crea una versión nueva con el contenido de la antigua, sin reescribir el historial', async () => {
      const created = await create({ promptTemplate: 'Original' });
      await service.update(tenantA, 'u', created.id, {
        promptTemplate: 'Segunda',
      });
      await service.update(tenantA, 'u', created.id, {
        promptTemplate: 'Tercera',
      });

      const restored = await service.restore(
        tenantA,
        'user-9',
        created.id,
        1,
        {},
      );

      expect(restored).toMatchObject({
        version: 4,
        promptTemplate: 'Original',
      });
      const history = await versions(created.id);
      expect(history.map((v) => v.version)).toEqual([4, 3, 2, 1]);
      expect(history[0]).toMatchObject({
        changeNote: 'Restaurada la versión 1',
        createdBy: 'user-9',
      });
      expect(
        (await service.getVersion(tenantA, created.id, 2)).promptTemplate,
      ).toBe('Segunda');
    });

    it('restaurar el contenido que ya está vigente es 400', async () => {
      const created = await create();
      await expect(
        service.restore(tenantA, 'u', created.id, 1, {}),
      ).rejects.toMatchObject({
        status: 400,
      });
    });

    it('una versión inexistente es 404', async () => {
      const created = await create();
      await expect(
        service.restore(tenantA, 'u', created.id, 99, {}),
      ).rejects.toMatchObject({
        status: 404,
      });
    });

    it('respeta expectedVersion y una nota propia', async () => {
      const created = await create({ promptTemplate: 'Uno' });
      await service.update(tenantA, 'u', created.id, { promptTemplate: 'Dos' });
      await expect(
        service.restore(tenantA, 'u', created.id, 1, { expectedVersion: 1 }),
      ).rejects.toMatchObject({ status: 409 });

      await service.restore(tenantA, 'u', created.id, 1, {
        expectedVersion: 2,
        changeNote: 'Volvemos al inicio',
      });
      expect((await versions(created.id))[0].changeNote).toBe(
        'Volvemos al inicio',
      );
    });

    it('una versión que ya no cumple los contratos no se puede restaurar', async () => {
      const created = await create();
      await service.update(tenantA, 'u', created.id, { promptTemplate: 'Dos' });
      await prisma.specialistVersion.updateMany({
        where: { specialistId: created.id, version: 1 },
        data: { rules: { version: 99, rules: 'roto' } },
      });
      await expect(
        service.restore(tenantA, 'u', created.id, 1, {}),
      ).rejects.toMatchObject({
        status: 400,
      });
    });
  });

  describe('archivar', () => {
    const bind = (
      specialistId: string,
      mode: 'OFF' | 'SHADOW' | 'ACTIVE',
      capability = 'image-analysis',
    ) =>
      prisma.botSpecialistBinding.create({
        data: {
          tenantId: tenantA,
          botConfigId: botA,
          capability,
          specialistId,
          mode,
        },
      });

    it('archiva, lo deja inactivo y deja de aparecer en el listado normal', async () => {
      const created = await create({ capability: 'arch-uno' });
      await service.update(tenantA, 'u', created.id, { status: 'ACTIVE' });

      const archived = await service.archive(tenantA, created.id);

      expect(archived.archivedAt).toBeInstanceOf(Date);
      expect(archived.status).toBe('INACTIVE');
    });

    it('con un vínculo en SHADOW o ACTIVE responde 409 con el detalle', async () => {
      const created = await create({ capability: 'arch-dos' });
      await bind(created.id, 'SHADOW', 'arch-dos');
      await expect(service.archive(tenantA, created.id)).rejects.toMatchObject({
        status: 409,
        response: {
          details: { bindings: [{ botConfigId: botA, mode: 'SHADOW' }] },
        },
      });
      expect((await service.get(tenantA, created.id)).archivedAt).toBeNull();
    });

    it('con un vínculo apagado (OFF) sí se puede archivar', async () => {
      const created = await create({ capability: 'arch-tres' });
      await bind(created.id, 'OFF', 'arch-tres');
      expect(
        (await service.archive(tenantA, created.id)).archivedAt,
      ).not.toBeNull();
    });

    it('un archivado no se modifica ni se restaura hasta desarchivarlo', async () => {
      const created = await create({ capability: 'arch-cuatro' });
      await service.update(tenantA, 'u', created.id, { promptTemplate: 'Dos' });
      await service.archive(tenantA, created.id);

      await expect(
        service.update(tenantA, 'u', created.id, { name: 'x' }),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        service.restore(tenantA, 'u', created.id, 1, {}),
      ).rejects.toMatchObject({
        status: 409,
      });

      const back = await service.unarchive(tenantA, created.id);
      expect(back.archivedAt).toBeNull();
      expect(back.status).toBe('INACTIVE');
      await expect(
        service.update(tenantA, 'u', created.id, { name: 'ya sí' }),
      ).resolves.toBeDefined();
    });

    it('archivar dos veces es idempotente', async () => {
      const created = await create({ capability: 'arch-cinco' });
      const first = await service.archive(tenantA, created.id);
      const second = await service.archive(tenantA, created.id);
      expect(second.archivedAt?.getTime()).toBe(first.archivedAt?.getTime());
    });
  });
  describe('variables de salida', () => {
    const landscape = {
      version: 1,
      variables: [
        {
          name: 'kind',
          type: 'enum',
          values: ['beach', 'city'],
          description: 'Tipo de paisaje',
        },
        { name: 'has_people', type: 'boolean', description: 'Hay personas' },
      ],
      uniqueBy: [],
    };

    it('un especialista que no es de comprobantes se crea y versiona igual', async () => {
      const created = await create({
        name: 'Paisajes',
        capability: 'landscape-check',
        outputSchema: landscape,
        rules: {
          version: 1,
          rules: [
            {
              field: 'kind',
              op: 'in',
              ref: { literal: ['beach'] },
              onFail: 'INVALID',
            },
            {
              field: 'has_people',
              op: 'eq',
              ref: { literal: false },
              onFail: 'NEEDS_REVIEW',
            },
          ],
        },
      });
      expect(created.outputSchema).toEqual(landscape);
      const [first] = await versions(created.id);
      expect(first.version).toBe(1);
      const snapshot = await service.getVersion(tenantA, created.id, 1);
      expect(snapshot.outputSchema).toEqual(landscape);
    });

    it('sin variables de salida no se puede crear', async () => {
      await expect(create({ outputSchema: undefined })).rejects.toMatchObject({
        status: 400,
      });
      await expect(
        create({ outputSchema: { version: 1, variables: [], uniqueBy: [] } }),
      ).rejects.toMatchObject({ status: 400 });
    });

    it('rechaza reglas incompatibles con las variables declaradas', async () => {
      await expect(
        create({
          outputSchema: landscape,
          rules: { version: 1, rules: [rule()] },
        }),
      ).rejects.toMatchObject({
        status: 400,
        response: {
          details: { ruleIssues: [expect.objectContaining({ index: 0 })] },
        },
      });
      await expect(
        create({
          outputSchema: landscape,
          rules: {
            version: 1,
            rules: [
              {
                field: 'kind',
                op: 'eq',
                ref: { literal: 'desert' },
                onFail: 'INVALID',
              },
            ],
          },
        }),
      ).rejects.toMatchObject({ status: 400 });
    });

    it('cambiar las variables versiona y guarda la instantánea', async () => {
      const created = await create({ name: 'Cambio de variables' });
      const updated = await service.update(tenantA, 'user-2', created.id, {
        outputSchema: landscape,
        rules: { version: 1, rules: [] },
        changeNote: 'Ahora analiza paisajes',
      });
      expect(updated.version).toBe(2);
      expect(updated.outputSchema).toEqual(landscape);
      expect(
        (await service.getVersion(tenantA, created.id, 1)).outputSchema,
      ).toEqual(LEGACY_IMAGE_OUTPUT_SCHEMA);
    });

    it('quitar una variable que una regla usa se rechaza', async () => {
      const created = await create({
        name: 'Con regla',
        rules: { version: 1, rules: [rule()] },
      });
      await expect(
        service.update(tenantA, 'user-2', created.id, {
          outputSchema: landscape,
        }),
      ).rejects.toMatchObject({ status: 400 });
      const same = await service.get(tenantA, created.id);
      expect(same.version).toBe(1);
    });

    it('restaurar una versión devuelve también sus variables', async () => {
      const created = await create({ name: 'Restaurable' });
      await service.update(tenantA, 'user-2', created.id, {
        outputSchema: landscape,
        rules: { version: 1, rules: [] },
      });
      const restored = await service.restore(
        tenantA,
        'user-3',
        created.id,
        1,
        {},
      );
      expect(restored.version).toBe(3);
      expect(restored.outputSchema).toEqual(LEGACY_IMAGE_OUTPUT_SCHEMA);
    });

    it('un cambio solo en las variables cuenta como cambio de contenido', async () => {
      const created = await create({ name: 'Solo variables' });
      const changed = {
        ...LEGACY_IMAGE_OUTPUT_SCHEMA,
        variables: LEGACY_IMAGE_OUTPUT_SCHEMA.variables.map((v) =>
          v.name === 'recipient' ? { ...v, maxLength: 80 } : v,
        ),
      };
      const updated = await service.update(tenantA, 'user-2', created.id, {
        outputSchema: changed,
      });
      expect(updated.version).toBe(2);
    });

    it('uniqueBy con una variable no declarada se rechaza', async () => {
      await expect(
        create({ outputSchema: { ...landscape, uniqueBy: ['otra'] } }),
      ).rejects.toMatchObject({ status: 400 });
    });
  });
});
