import { Injectable } from '@nestjs/common';
import { MessageJobPayload } from '../queues';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

export interface SignedJobPayload extends MessageJobPayload {
  _signature: string;
  _signedAt: number;
  _expiresAt: number;
}

@Injectable()
export class JobSigner {
  private readonly IMMEDIATE_JOB_MAX_AGE_MS = 24 * 60 * 60 * 1000;
  private readonly SCHEDULED_GRACE_MS = 48 * 60 * 60 * 1000;
  private readonly ABSOLUTE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

  constructor(private readonly config: ConfigService) {}

  sign(payload: MessageJobPayload): SignedJobPayload {
    const signedAt = Date.now();
    const expiresAt = this.computeExpiresAt(payload, signedAt);
    const secret = this.config.get<string>('webhook.signingSecret') ?? '';

    const content = this.buildSignableContent(payload, signedAt, expiresAt);

    const signature = crypto
      .createHmac('sha256', secret)
      .update(content)
      .digest('hex');

    return {
      ...payload,
      _signature: signature,
      _signedAt: signedAt,
      _expiresAt: expiresAt,
    };
  }

  verify(payload: SignedJobPayload): { valid: boolean; reason?: string } {
    if (!payload._signature || !payload._signedAt || !payload._expiresAt) {
      return {
        valid: false,
        reason: 'Job sin firma — posible inyección directa en Redis',
      };
    }

    const now = Date.now();
    if (now > payload._expiresAt) {
      const overdueHours = Math.round((now - payload._expiresAt) / 3600000);
      return {
        valid: false,
        reason: `Job expirado hace ${overdueHours}h. Vencimiento: ${new Date(payload._expiresAt).toISOString()}`,
      };
    }

    const secret = this.config.get<string>('webhook.signingSecret') ?? '';
    const content = this.buildSignableContent(
      payload,
      payload._signedAt,
      payload._expiresAt,
    );

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

  private computeExpiresAt(
    payload: MessageJobPayload,
    signedAt: number,
  ): number {
    const absoluteCeiling = signedAt + this.ABSOLUTE_MAX_AGE_MS;

    if (!payload.sheduledAt) {
      return Math.min(
        signedAt + this.IMMEDIATE_JOB_MAX_AGE_MS,
        absoluteCeiling,
      );
    }

    const scheduledAtMs = new Date(payload.sheduledAt).getTime();

    if (Number.isNaN(scheduledAtMs)) {
      return Math.min(
        signedAt + this.IMMEDIATE_JOB_MAX_AGE_MS,
        absoluteCeiling,
      );
    }

    return Math.min(scheduledAtMs + this.SCHEDULED_GRACE_MS, absoluteCeiling);
  }

  private buildSignableContent(
    payload: MessageJobPayload,
    signedAt: number,
    expiresAt: number,
  ): string {
    return [
      payload.messageId,
      payload.tenantId,
      payload.channel,
      payload.recipient,
      payload.connectionId ?? '',
      signedAt,
      expiresAt,
    ].join(':');
  }
}
