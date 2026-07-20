import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/shared/prisma.service';
import * as crypto from 'crypto';
import { CreateWebhookDto } from './dto/CreateWebhook.dto';

@Injectable()
export class WebhookService {
  constructor(private readonly prisma: PrismaService) {}

  async createWebhook(tenantId: string, dto: CreateWebhookDto) {
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

  async findAll(tenantId: string) {
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

  async remove(id: string, tenantId: string) {
    const webhook = await this.prisma.webhookEndpoint.findUnique({
      where: { id, tenantId },
    });
    if (!webhook) throw new NotFoundException(`Webhook ${id} no encontrado`);

    return this.prisma.webhookEndpoint.update({
      where: { id },
      data: { isActive: false },
    });
  }

  async getDeliveries(webhookId: string, tenantId: string) {
    const webhook = await this.prisma.webhookEndpoint.findFirst({
      where: { id: webhookId, tenantId },
    });
    if (!webhook)
      throw new NotFoundException(`Webhook ${webhookId} no encontrado`);

    return this.prisma.webhookDelivery.findMany({
      where: { webhookId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }
}
