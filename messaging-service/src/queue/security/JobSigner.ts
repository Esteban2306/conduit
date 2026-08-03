import { Injectable } from '@nestjs/common';
import { MessageJobPayload } from '../queues';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

export interface SignedJobPayload extends MessageJobPayload {
  _signature: string;
  _signedAt: number;
}

@Injectable()
export class JobSigner {
  private readonly MAX_JOB_AGE_MS = 72 * 60 * 60 * 1000;

  constructor(private readonly config: ConfigService) {}

  sign(payload: MessageJobPayload): SignedJobPayload {
    const signedAt = Date.now();
    const secret = this.config.get<string>('webhook.signingSecret') ?? '';

    const content = this.buildSignableContent(payload, signedAt);

    const signature = crypto
      .createHmac('sha256', secret)
      .update(content)
      .digest('hex');

    return {
      ...payload,
      _signature: signature,
      _signedAt: signedAt,
    };
  }

  verify(payload: SignedJobPayload): { valid: boolean; reason?: string } {
    if (!payload._signature || !payload._signedAt) {
      return {
        valid: false,
        reason: 'Job sin firma — posible inyección directa en Redis',
      };
    }

    const age = Date.now() - payload._signedAt;
    if (age > this.MAX_JOB_AGE_MS) {
      return {
        valid: false,
        reason: `Job expirado. Edad: ${Math.round(age / 3600000)}h. Máximo permitido: 24h`,
      };
    }

    const secret = this.config.get<string>('webhook.signingSecret') ?? '';
    const content = this.buildSignableContent(payload, payload._signedAt);

    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(content)
      .digest('hex');

    const sigBuffer = Buffer.from(payload._signature, 'hex');
    const expectedBuffer = Buffer.from(expectedSignature, 'hex');

    if (sigBuffer.length !== expectedBuffer.length) {
      return { valid: false, reason: 'Firma con longitud inválida' };
    }

    const isValid = crypto.timingSafeEqual(sigBuffer, expectedBuffer);

    return isValid
      ? { valid: true }
      : {
          valid: false,
          reason: 'Firma inválida — job posiblemente manipulado',
        };
  }

  private buildSignableContent(
    payload: MessageJobPayload,
    signedAt: number,
  ): string {
    return [
      payload.messageId,
      payload.tenantId,
      payload.channel,
      payload.recipient,
      payload.connectionId ?? '',
      signedAt,
    ].join(':');
  }
}
