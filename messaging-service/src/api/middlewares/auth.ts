import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import * as crypto from 'crypto';

export const IS_PUBLIC_KEY = 'isPublic';

export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly config: ConfigService,
    private readonly reflector: Reflector,
  ) {}

  canActivate(
    context: ExecutionContext,
  ): boolean | Promise<boolean> | Observable<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<Request>();

    const apiKey =
      (request.headers['x-api-key'] as string) ??
      this.extractBearerToken(request);

    if (!apiKey) {
      throw new UnauthorizedException(
        'API Key requerida. Envíala en el header x-api-key',
      );
    }

    const validKey = this.config.get<string>('app.apiSecretKey');

    if (!this.safeCompare(apiKey, validKey ?? '')) {
      throw new UnauthorizedException('API Key inválida');
    }

    return true;
  }

  private extractBearerToken(request: Request): string | undefined {
    const auth = request.headers['authorization'];
    if (!auth?.startsWith('Bearer ')) return undefined;
    return auth?.slice(7);
  }

  private safeCompare(a: string, b: string): boolean {
    const aBuffer = Buffer.from(a);
    const bBuffer = Buffer.from(b);

    if (aBuffer.length !== bBuffer.length) {
      return false;
    }

    return crypto.timingSafeEqual(aBuffer, bBuffer);
  }
}
