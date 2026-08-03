import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { UserRole } from '@prisma/client';
import { ApiKeyService } from './ApiKeyService';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly apiKeyService: ApiKeyService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const rawKey = request.headers['x-api-key'];

    if (!rawKey || Array.isArray(rawKey)) {
      throw new UnauthorizedException('API key faltante o inválida.');
    }

    const result = await this.apiKeyService.validate(rawKey);
    if (!result) {
      throw new UnauthorizedException('API key inválida o revocada.');
    }

    (request as Request & { user?: unknown }).user = {
      sub: `apikey:${result.apiKeyId}`,
      tenantId: result.tenantId,
      role: UserRole.ADMIN,
    };

    return true;
  }
}
