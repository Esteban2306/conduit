import { Injectable } from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { PrismaService } from 'src/shared/prisma.service';

const KEY_PREFIX_LENGTH = 12;

interface ValidatedApiKey {
  tenantId: string;
  apiKeyId: string;
}

@Injectable()
export class ApiKeyService {
  constructor(private readonly prisma: PrismaService) {}

  async create(tenantId: string, name: string): Promise<{ key: string }> {
    const { rawKey, keyPrefix, keyHash } = this.generateKey();

    await this.prisma.apiKey.create({
      data: { tenantId, name, keyPrefix, keyHash, isActive: true },
    });

    return { key: rawKey };
  }

  async findAll(tenantId: string) {
    return this.prisma.apiKey.findMany({
      where: { tenantId },
      select: {
        id: true,
        name: true,
        keyPrefix: true,
        isActive: true,
        lastUsedAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async revoke(id: string, tenantId: string): Promise<void> {
    await this.prisma.apiKey.updateMany({
      where: { id, tenantId },
      data: { isActive: false },
    });
  }

  async validate(rawKey: string): Promise<ValidatedApiKey | null> {
    if (!rawKey || rawKey.length < KEY_PREFIX_LENGTH) return null;

    const keyPrefix = rawKey.slice(0, KEY_PREFIX_LENGTH);
    const providedHash = createHash('sha256').update(rawKey).digest('hex');

    const candidate = await this.prisma.apiKey.findFirst({
      where: { keyPrefix, isActive: true },
    });

    if (!candidate) return null;

    const candidateBuf = Buffer.from(candidate.keyHash, 'hex');
    const providedBuf = Buffer.from(providedHash, 'hex');

    if (
      candidateBuf.length !== providedBuf.length ||
      !timingSafeEqual(candidateBuf, providedBuf)
    ) {
      return null;
    }

    this.prisma.apiKey
      .update({ where: { id: candidate.id }, data: { lastUsedAt: new Date() } })
      .catch(() => {});

    return { tenantId: candidate.tenantId, apiKeyId: candidate.id };
  }

  private generateKey(): {
    rawKey: string;
    keyPrefix: string;
    keyHash: string;
  } {
    const rawKey = `ck_${randomBytes(24).toString('hex')}`;
    const keyPrefix = rawKey.slice(0, KEY_PREFIX_LENGTH);
    const keyHash = createHash('sha256').update(rawKey).digest('hex');
    return { rawKey, keyPrefix, keyHash };
  }
}
