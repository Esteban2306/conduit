import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { JwtPayload } from '../types/jwt.types';

const MANAGERS: ReadonlySet<string> = new Set([UserRole.OWNER, UserRole.ADMIN]);

@Injectable()
export class TenantAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<{ user?: JwtPayload | undefined }>();
    const user = request.user;

    if (!user) {
      throw new ForbiddenException('Usuario no autenticado.');
    }
    if (!MANAGERS.has(user.role)) {
      throw new ForbiddenException(
        'Acceso denegado. Solo el propietario o un administrador pueden realizar esta acción.',
      );
    }
    return true;
  }
}
