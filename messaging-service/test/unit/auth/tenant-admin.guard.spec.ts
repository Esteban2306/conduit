import { ForbiddenException } from '@nestjs/common';
import { TenantAdminGuard } from 'src/auth/guards/tenant-admin.guard';

const contextOf = (user: unknown) =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  }) as never;

describe('TenantAdminGuard', () => {
  const guard = new TenantAdminGuard();

  it.each(['OWNER', 'ADMIN'])('deja pasar al rol %s', (role) => {
    expect(
      guard.canActivate(contextOf({ sub: 'u', tenantId: 't', role })),
    ).toBe(true);
  });

  it.each(['MEMBER', 'owner', 'admin', 'SUPERUSER', '', undefined, null, 5])(
    'rechaza el rol %p',
    (role) => {
      expect(() =>
        guard.canActivate(contextOf({ sub: 'u', tenantId: 't', role })),
      ).toThrow(ForbiddenException);
    },
  );

  it('rechaza una petición sin usuario', () => {
    expect(() => guard.canActivate(contextOf(undefined))).toThrow(
      ForbiddenException,
    );
  });
});
