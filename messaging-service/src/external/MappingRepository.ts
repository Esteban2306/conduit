import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/shared/prisma.service';
import { MappingRule } from './hooks/VariableMapper';
import { WebhookMapping } from '@prisma/client';

@Injectable()
export class MappingRepository {
  constructor(private readonly prisma: PrismaService) {}

  async find(
    botConfigId: string,
    eventType: string,
  ): Promise<MappingRule | null> {
    const mapping = await this.prisma.webhookMapping.findFirst({
      where: { botConfigId, eventType, isActive: true },
      select: { rules: true },
    });

    return mapping?.rules as MappingRule | null;
  }

  async findAll(botConfigId: string): Promise<WebhookMapping[]> {
    return this.prisma.webhookMapping.findMany({
      where: { botConfigId },
      orderBy: { eventType: 'asc' },
    });
  }

  async upsert(
    botConfigId: string,
    eventType: string,
    rules: MappingRule,
    description?: string,
  ): Promise<WebhookMapping> {
    return this.prisma.webhookMapping.upsert({
      where: { botConfigId_eventType: { botConfigId, eventType } },
      create: { botConfigId, eventType, rules: rules as any, description },
      update: { rules: rules as any, description, updatedAt: new Date() },
    });
  }

  async delete(botConfigId: string, eventType: string): Promise<void> {
    await this.prisma.webhookMapping.deleteMany({
      where: { botConfigId, eventType },
    });
  }
}
