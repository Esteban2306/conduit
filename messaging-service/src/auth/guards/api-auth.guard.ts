import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { JwtGuard } from './jwt-auth.guard';
import { ApiKeyGuard } from '../api/ApiKeyGuard';

@Injectable()
export class ApiAuthGuard implements CanActivate {
  constructor(
    private readonly jwtGuard: JwtGuard,
    private readonly apiKeyGuard: ApiKeyGuard,
  ) {}

  canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const hasApiKey = Boolean(request.headers['x-api-key']);

    return hasApiKey
      ? (this.apiKeyGuard.canActivate(context) as Promise<boolean>)
      : (this.jwtGuard.canActivate(context) as Promise<boolean>);
  }
}
