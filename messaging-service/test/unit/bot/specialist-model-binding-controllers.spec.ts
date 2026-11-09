import { GUARDS_METADATA } from '@nestjs/common/constants';
import { ApiAuthGuard } from 'src/auth/guards/api-auth.guard';
import { TenantAdminGuard } from 'src/auth/guards/tenant-admin.guard';
import { SpecialistBindingController } from 'src/bot/specialists/admin/SpecialistBinding.controller';
import { SpecialistModelController } from 'src/bot/specialists/admin/SpecialistModel.controller';
import {
  createSpecialistModelSchema,
  updateSpecialistModelSchema,
} from 'src/bot/specialists/admin/specialist-model.schemas';
import { upsertBindingSchema } from 'src/bot/specialists/admin/specialist-binding.schemas';

const guardsOf = (target: object): unknown[] =>
  (Reflect.getMetadata(GUARDS_METADATA, target) as unknown[] | undefined) ?? [];
const methods = (controller: { prototype: object }) =>
  controller.prototype as unknown as Record<string, object>;

describe('permisos de los modelos y vínculos de especialistas', () => {
  it.each([SpecialistModelController, SpecialistBindingController])(
    '%p exige autenticación en toda la clase',
    (controller) => {
      expect(guardsOf(controller)).toContain(ApiAuthGuard);
    },
  );

  it.each(['create', 'update', 'reactivate', 'remove'])(
    'modelos: %s exige propietario o administrador',
    (method) => {
      expect(guardsOf(methods(SpecialistModelController)[method])).toContain(
        TenantAdminGuard,
      );
    },
  );

  it('modelos: el listado solo exige autenticación', () => {
    expect(guardsOf(methods(SpecialistModelController).list)).not.toContain(
      TenantAdminGuard,
    );
  });

  it.each(['upsert', 'remove'])(
    'vínculos: %s exige propietario o administrador',
    (method) => {
      expect(guardsOf(methods(SpecialistBindingController)[method])).toContain(
        TenantAdminGuard,
      );
    },
  );

  it('vínculos: el listado solo exige autenticación', () => {
    expect(guardsOf(methods(SpecialistBindingController).list)).not.toContain(
      TenantAdminGuard,
    );
  });
});

describe('delegación con el tenant del token', () => {
  const user = { sub: 'u', tenantId: 'tenant-token', role: 'OWNER' };

  it('modelos', () => {
    const service = {
      list: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      reactivate: jest.fn(),
      remove: jest.fn(),
    };
    const controller = new SpecialistModelController(service as never);
    controller.list(user, 's1');
    controller.create(user, 's1', { a: 1 });
    controller.update(user, 's1', 'm1', { b: 2 });
    controller.reactivate(user, 's1', 'm1');
    controller.remove(user, 's1', 'm1');
    expect(service.list).toHaveBeenCalledWith('tenant-token', 's1');
    expect(service.create).toHaveBeenCalledWith('tenant-token', 's1', { a: 1 });
    expect(service.update).toHaveBeenCalledWith('tenant-token', 's1', 'm1', {
      b: 2,
    });
    expect(service.reactivate).toHaveBeenCalledWith('tenant-token', 's1', 'm1');
    expect(service.remove).toHaveBeenCalledWith('tenant-token', 's1', 'm1');
  });

  it('vínculos', () => {
    const service = { list: jest.fn(), upsert: jest.fn(), remove: jest.fn() };
    const controller = new SpecialistBindingController(service as never);
    controller.list(user, 'b1');
    controller.upsert(user, 'b1', 'image-analysis', { mode: 'OFF' });
    controller.remove(user, 'b1', 'image-analysis');
    expect(service.list).toHaveBeenCalledWith('tenant-token', 'b1');
    expect(service.upsert).toHaveBeenCalledWith(
      'tenant-token',
      'b1',
      'image-analysis',
      { mode: 'OFF' },
    );
    expect(service.remove).toHaveBeenCalledWith(
      'tenant-token',
      'b1',
      'image-analysis',
    );
  });
});

describe('esquemas de modelos de especialista', () => {
  const key = `sk-ant-${'a'.repeat(40)}`;
  const valid = {
    provider: 'ANTHROPIC',
    model: 'claude-haiku-5-5',
    apiKey: key,
    role: 'IMAGE_ANALYSIS',
    tier: 'PAID',
    priority: 1,
  };
  const ok = (extra: Record<string, unknown> = {}) =>
    createSpecialistModelSchema.safeParse({ ...valid, ...extra }).success;

  it('acepta un modelo válido', () => expect(ok()).toBe(true));

  it.each(['IMAGE_ANALYSIS', 'FALLBACK'])('acepta el rol %s', (role) =>
    expect(ok({ role })).toBe(true),
  );

  it.each(['CONVERSATION', 'CLASSIFIER', 'OTRO'])('rechaza el rol %s', (role) =>
    expect(ok({ role })).toBe(false),
  );

  it.each([
    'corta',
    'YOUR_API_KEY_HERE_0000000000',
    'placeholder-de-relleno-OPENAI_KEY',
    'x'.repeat(600),
    '',
  ])('rechaza la clave de relleno o inválida "%s"', (apiKey) =>
    expect(ok({ apiKey })).toBe(false),
  );

  it('CUSTOM exige baseUrl y esta debe ser http o https', () => {
    expect(ok({ provider: 'CUSTOM' })).toBe(false);
    expect(ok({ provider: 'CUSTOM', baseUrl: 'https://llm.test/v1' })).toBe(
      true,
    );
    expect(ok({ provider: 'CUSTOM', baseUrl: 'ftp://llm.test' })).toBe(false);
    expect(ok({ provider: 'CUSTOM', baseUrl: 'javascript:alert(1)' })).toBe(
      false,
    );
    expect(ok({ provider: 'CUSTOM', baseUrl: 'no es una url' })).toBe(false);
  });

  it.each([
    ['prioridad 0', { priority: 0 }],
    ['prioridad enorme', { priority: 5000 }],
    ['proveedor desconocido', { provider: 'ACME' }],
    ['tier desconocido', { tier: 'GRATIS' }],
    ['límite negativo', { dailyTokenLimit: -1 }],
    ['modelo con salto de línea', { model: 'a\nb' }],
    ['dueño enviado por el cliente', { specialistId: 'otro' }],
    ['bot enviado por el cliente', { botConfigId: 'otro' }],
  ])('rechaza %s', (_name, extra) => expect(ok(extra)).toBe(false));

  describe('edición', () => {
    const upd = (value: Record<string, unknown>) =>
      updateSpecialistModelSchema.safeParse(value).success;

    it('acepta rotar la clave, cambiar prioridad y limpiar límites', () => {
      expect(upd({ apiKey: key })).toBe(true);
      expect(upd({ priority: 3, isActive: false })).toBe(true);
      expect(upd({ dailyTokenLimit: null, baseUrl: null })).toBe(true);
    });

    it.each([
      ['vacío', {}],
      ['proveedor (inmutable)', { provider: 'OPENAI' }],
      ['dueño', { specialistId: 'x' }],
      ['rol de conversación', { role: 'CONVERSATION' }],
      ['clave de relleno', { apiKey: 'YOUR_API_KEY_HERE_0000000000' }],
    ])('rechaza %s', (_name, value) => expect(upd(value)).toBe(false));
  });
});

describe('esquema de vínculos', () => {
  const uuid = '0b0f3c64-6a3f-4a8c-9a56-2f0d6a1b7c11';

  it('aplica los valores seguros por defecto', () => {
    expect(upsertBindingSchema.parse({ specialistId: uuid })).toEqual({
      specialistId: uuid,
      mode: 'OFF',
      timeoutMs: 12000,
      onFailure: 'DEGRADE',
    });
  });

  it.each([
    ['sin especialista', {}],
    ['especialista que no es uuid', { specialistId: 'x' }],
    ['modo desconocido', { specialistId: uuid, mode: 'FORCE' }],
    ['timeout bajo', { specialistId: uuid, timeoutMs: 999 }],
    ['timeout alto', { specialistId: uuid, timeoutMs: 30001 }],
    ['timeout decimal', { specialistId: uuid, timeoutMs: 1500.5 }],
    ['política desconocida', { specialistId: uuid, onFailure: 'IGNORE' }],
    ['tenant enviado por el cliente', { specialistId: uuid, tenantId: 'x' }],
    ['capacidad en el cuerpo', { specialistId: uuid, capability: 'otra' }],
  ])('rechaza %s', (_name, value) =>
    expect(upsertBindingSchema.safeParse(value).success).toBe(false),
  );
});
