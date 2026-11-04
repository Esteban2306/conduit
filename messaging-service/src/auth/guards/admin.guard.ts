import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { JwtPayload } from '../types/jwt.types';
import { UserRole } from '@prisma/client';

@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const user: JwtPayload | undefined = req.user;

    if (!user) {
      throw new ForbiddenException('Usuario no autenticado.');
    }

    if (user.role !== UserRole.ADMIN) {
      throw new ForbiddenException(
        'Acceso denegado. Solo administradores pueden realizar esta acción.',
      );
    }

    return true;
  }
}
