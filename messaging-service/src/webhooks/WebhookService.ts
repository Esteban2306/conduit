import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from 'src/shared/prisma.service';
import * as crypto from 'crypto';

export interface CreateWebhookDto {
  url: string;
  events: string[];
}

@Injectable()
export class WebhookService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async createWebhook(dto: CreateWebhookDto) {
    const tenantId = this.config.get<string>('tenant.default') ?? 'default';

    const secret = crypto.randomBytes(32).toString('hex');

    return this.prisma.webhookEndpoint.create({
      data: {
        tenantId,
        url: dto.url,
        secret,
        events: dto.events,
        isActive: true,
      },
    });
  }

  async findAll() {
    const tenantId = this.config.get<string>('tenant.default') ?? 'default';
    return this.prisma.webhookEndpoint.findMany({
      where: { tenantId, isActive: true },
      select: {
        id: true,
        url: true,
        events: true,
        isActive: true,
        createdAt: true,
      },
    });
  }

  async remove(id: string) {
    const webhook = await this.prisma.webhookEndpoint.findUnique({
      where: { id },
    });
    if (!webhook) throw new NotFoundException(`Webhook ${id} no encontrado`);

    return this.prisma.webhookEndpoint.update({
      where: { id },
      data: { isActive: false },
    });
  }

  async getDeliveries(webhookId: string) {
    return this.prisma.webhookDelivery.findMany({
      where: { webhookId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }
}
