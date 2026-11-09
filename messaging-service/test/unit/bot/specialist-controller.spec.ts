import { GUARDS_METADATA } from '@nestjs/common/constants';
import { AdminGuard } from 'src/auth/guards/admin.guard';
import { ApiAuthGuard } from 'src/auth/guards/api-auth.guard';
import { SpecialistController } from 'src/bot/specialists/admin/Specialist.controller';

const guardsOf = (target: object): unknown[] =>
  (Reflect.getMetadata(GUARDS_METADATA, target) as unknown[] | undefined) ?? [];

const proto = SpecialistController.prototype as unknown as Record<
  string,
  object
>;

describe('SpecialistController: permisos', () => {
  it('toda la clase exige autenticación', () => {
    expect(guardsOf(SpecialistController)).toContain(ApiAuthGuard);
  });

  it.each(['create', 'update', 'restore', 'archive', 'unarchive'])(
    '%s exige además ser administrador',
    (method) => {
      expect(guardsOf(proto[method])).toContain(AdminGuard);
    },
  );

  it.each(['list', 'getByKey', 'get', 'listVersions', 'getVersion'])(
    '%s solo exige autenticación (es de consulta)',
    (method) => {
      expect(guardsOf(proto[method])).not.toContain(AdminGuard);
    },
  );
});

describe('SpecialistController: delegación con el tenant del token', () => {
  const service = {
    list: jest.fn(),
    getByKey: jest.fn(),
    get: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    restore: jest.fn(),
    archive: jest.fn(),
    unarchive: jest.fn(),
    listVersions: jest.fn(),
    getVersion: jest.fn(),
  };
  const controller = new SpecialistController(service as never);
  const user = { sub: 'user-1', tenantId: 'tenant-del-token', role: 'ADMIN' };

  beforeEach(() => jest.clearAllMocks());

  it('create pasa el tenant y el autor del token', () => {
    controller.create(user, { name: 'x' });
    expect(service.create).toHaveBeenCalledWith('tenant-del-token', 'user-1', {
      name: 'x',
    });
  });

  it('update y restore pasan tenant, autor e id', () => {
    controller.update(user, 'id-1', { name: 'y' });
    expect(service.update).toHaveBeenCalledWith(
      'tenant-del-token',
      'user-1',
      'id-1',
      { name: 'y' },
    );
    controller.restore(user, 'id-1', 3, {});
    expect(service.restore).toHaveBeenCalledWith(
      'tenant-del-token',
      'user-1',
      'id-1',
      3,
      {},
    );
  });

  it('las consultas usan solo el tenant del token', () => {
    controller.list(user, {});
    controller.get(user, 'id-1');
    controller.getByKey(user, 'clave');
    controller.listVersions(user, 'id-1');
    controller.getVersion(user, 'id-1', 2);
    for (const call of [
      service.list.mock.calls[0],
      service.get.mock.calls[0],
      service.getByKey.mock.calls[0],
      service.listVersions.mock.calls[0],
      service.getVersion.mock.calls[0],
    ]) {
      expect((call as unknown[])[0]).toBe('tenant-del-token');
    }
  });

  it('archive y unarchive usan el tenant del token', () => {
    controller.archive(user, 'id-1');
    controller.unarchive(user, 'id-1');
    expect(service.archive).toHaveBeenCalledWith('tenant-del-token', 'id-1');
    expect(service.unarchive).toHaveBeenCalledWith('tenant-del-token', 'id-1');
  });
});
