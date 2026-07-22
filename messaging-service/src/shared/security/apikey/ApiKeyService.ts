import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from 'src/shared/prisma.service';

const KEY_PREFIX_LENGTH = 12;

@Injectable()
export class ApiKeyService {
  constructor(private readonly prisma: PrismaService) {}

  async create(tenantId: string, name: string) {
    const plainKey = `sk_live_${randomBytes(24).toString('hex')}`;
    const keyPrefix = plainKey.slice(0, KEY_PREFIX_LENGTH);
    const keyHash = this.hash(plainKey);

    const apiKey = await this.prisma.apiKey.create({
      data: { tenantId, name, keyPrefix, keyHash },
      select: { id: true, name: true, keyPrefix: true, createdAt: true },
    });

    return { ...apiKey, key: plainKey };
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

  async revoke(id: string, tenantId: string) {
    const { count } = await this.prisma.apiKey.updateMany({
      where: { id, tenantId },
      data: { isActive: false },
    });
    return count > 0;
  }

  async validate(plainKey: string): Promise<{ tenantId: string } | null> {
    const keyHash = this.hash(plainKey);

    const apiKey = await this.prisma.apiKey.findFirst({
      where: { keyHash, isActive: true },
      select: { id: true, tenantId: true },
    });

    if (!apiKey) return null;

    await this.prisma.apiKey.update({
      where: { id: apiKey.id },
      data: { lastUsedAt: new Date() },
    });

    return { tenantId: apiKey.tenantId };
  }

  private hash(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }
}
