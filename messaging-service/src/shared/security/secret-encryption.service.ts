import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const KEY_LENGTH = 32;
export const SEALED_PREFIX = 'enc:v1:';

@Injectable()
export class SecretEncryptionService implements OnModuleInit {
  private key!: Buffer;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const hexKey = this.config.get<string>('webhook.encryptionKey');
    if (!hexKey) {
      throw new Error(
        'INTEGRATION_ENCRYPTION_KEY no configurada. Genera una con: ' +
          `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
      );
    }

    const key = Buffer.from(hexKey, 'hex');

    if (key.length !== KEY_LENGTH) {
      throw new Error(
        `INTEGRATION_ENCRYPTION_KEY debe tener ${KEY_LENGTH} bytes (64 caracteres hex).`,
      );
    }

    this.key = key;
  }

  encrypt(plainText: string): string {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const encrypted = Buffer.concat([
      cipher.update(plainText, 'utf8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();

    return [
      iv.toString('hex'),
      authTag.toString('hex'),
      encrypted.toString('hex'),
    ].join(':');
  }

  decrypt(payload: string): string {
    const [ivHex, authTagHex, dataHex] = payload.split(':');
    if (!ivHex || !authTagHex || !dataHex) {
      throw new Error('Formato de secreto cifrado inválido.');
    }

    const decipher = createDecipheriv(
      ALGORITHM,
      this.key,
      Buffer.from(ivHex, 'hex'),
    );
    decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));

    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(dataHex, 'hex')),
      decipher.final(),
    ]);

    return decrypted.toString('utf8');
  }

  isSealed(stored: string | null | undefined): boolean {
    return !!stored && stored.startsWith(SEALED_PREFIX);
  }

  seal(plainText: string): string {
    return `${SEALED_PREFIX}${this.encrypt(plainText)}`;
  }

  open(stored: string): string {
    return this.isSealed(stored)
      ? this.decrypt(stored.slice(SEALED_PREFIX.length))
      : stored;
  }

  last4(plainText: string): string | null {
    const trimmed = plainText.trim();
    return trimmed.length >= 8 ? trimmed.slice(-4) : null;
  }

  generateSecret(): string {
    return randomBytes(32).toString('hex');
  }
}
