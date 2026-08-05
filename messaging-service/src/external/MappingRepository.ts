import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/shared/prisma.service';
import { MappingRule } from './hooks/VariableMapper';
import { WebhookMapping } from '@prisma/client';
import { WebhookAction } from './hooks/webhook-action.types';

export interface FullMapping {
  rules: MappingRule;
  action: WebhookAction | null;
}

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

  async findFull(
    botConfigId: string,
    eventType: string,
  ): Promise<FullMapping | null> {
    const mapping = await this.prisma.webhookMapping.findFirst({
      where: { botConfigId, eventType, isActive: true },
      select: { rules: true, action: true },
    });

    if (!mapping) return null;

    return {
      rules: mapping.rules as MappingRule,
      action: (mapping.action as unknown as WebhookAction | null) ?? null,
    };
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
    action?: WebhookAction,
  ): Promise<WebhookMapping> {
    return this.prisma.webhookMapping.upsert({
      where: { botConfigId_eventType: { botConfigId, eventType } },
      create: {
        botConfigId,
        eventType,
        rules: rules as any,
        description,
        action: action ? (action as any) : undefined,
      },
      update: {
        rules: rules as any,
        description,
        action: action ? (action as any) : undefined,
        updatedAt: new Date(),
      },
    });
  }

  async delete(botConfigId: string, eventType: string): Promise<void> {
    await this.prisma.webhookMapping.deleteMany({
      where: { botConfigId, eventType },
    });
  }
}
