import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';

import {
  computeHmacSignature,
  isTimestampFresh,
  safeCompareSignatures,
} from './hmac-crypto.util';

import type { SignatureSecretResolver } from './signature-secret-resolver.interface';
import {
  HMAC_DEFAULT_WINDOW_SECONDS,
  HMAC_HEADERS,
} from './hmac-headers.constants';
import type { Request } from 'express';

export interface RequestWithRawBody extends Request {
  rawBody?: Buffer;
}

@Injectable()
export abstract class HmacSignatureGuardBase implements CanActivate {
  protected readonly windowSeconds: number = HMAC_DEFAULT_WINDOW_SECONDS;

  constructor(private readonly resolver: SignatureSecretResolver) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithRawBody>();

    const integrationId = this.readHeader(request, HMAC_HEADERS.INTEGRATION_ID);
    const timestampHeader = this.readHeader(request, HMAC_HEADERS.TIMESTAMP);
    const signatureHeader = this.readHeader(request, HMAC_HEADERS.SIGNATURE);

    if (!integrationId || !timestampHeader || !signatureHeader) {
      throw new UnauthorizedException('Faltan headers de firma requeridos.');
    }

    const timestampSeconds = Number(timestampHeader);
    if (!isTimestampFresh(timestampSeconds, this.windowSeconds)) {
      throw new UnauthorizedException(
        'Timestamp inválido o fuera de la ventana permitida.',
      );
    }

    if (!request.rawBody) {
      throw new UnauthorizedException(
        'No fue posible leer el cuerpo crudo de la solicitud.',
      );
    }

    const resolved = await this.resolver.resolve(integrationId, request);
    if (!resolved) {
      throw new UnauthorizedException('Integración no encontrada o inactiva.');
    }

    const expectedSignature = computeHmacSignature(
      resolved.secret,
      timestampHeader,
      request.rawBody.toString('utf8'),
    );

    if (!safeCompareSignatures(expectedSignature, signatureHeader)) {
      throw new UnauthorizedException('Firma inválida.');
    }

    (
      request as Request & { signatureContext?: Record<string, unknown> }
    ).signatureContext = resolved.context;

    await this.resolver.onVerified?.(integrationId, resolved.context);

    return true;
  }

  private readHeader(request: Request, name: string): string | undefined {
    const value = request.headers[name];
    return Array.isArray(value) ? value[0] : value;
  }
}
