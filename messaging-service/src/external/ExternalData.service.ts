import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/shared/prisma.service';
import { EventBusService } from 'src/infra/events/event.service';
import { VariableMapper } from './hooks/VariableMapper';
import { VariableStore } from './VariableStore';
import { MappingRepository } from './MappingRepository';
import { MappingRule } from './hooks/VariableMapper';
import { SourceVariable } from '@prisma/client';

@Injectable()
export class ExternalDataService {
  private readonly logger = new Logger(ExternalDataService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventBus: EventBusService,
    private readonly mapper: VariableMapper,
    private readonly store: VariableStore,
    private readonly mappings: MappingRepository,
  ) {}

  async receiveWebhook(
    botConfigId: string,
    eventType: string,
    payload: Record<string, any>,
  ): Promise<{ received: boolean; eventId: string; mapped: number }> {
    const event = await this.prisma.externalDataEvent.create({
      data: {
        botConfigId,
        eventType,
        payload: payload as any,
        source: 'webhook',
      },
    });

    try {
      const rules = await this.mappings.find(botConfigId, eventType);

      let mapped = 0;
      if (rules) {
        const variables = this.mapper.map(rules, payload);
        mapped = await this.store.save(
          botConfigId,
          variables,
          SourceVariable.WEBHOOK,
        );
      } else {
        this.logger.warn(
          `Sin mapping para eventType "${eventType}" en bot ${botConfigId}`,
        );
      }

      await this.prisma.externalDataEvent.update({
        where: { id: event.id },
        data: { processedAt: new Date() },
      });

      this.eventBus.publish('external_data.processed', {
        eventId: event.id,
        botConfigId,
        eventType,
        mapped,
      });

      return { received: true, eventId: event.id, mapped };
    } catch (err) {
      await this.prisma.externalDataEvent.update({
        where: { id: event.id },
        data: { failedAt: new Date(), error: err.message },
      });
      this.logger.error(`Error procesando webhook ${event.id}: ${err.message}`);
      throw err;
    }
  }

  async injectDirect(
    botConfigId: string,
    variables: Record<string, string>,
    source: SourceVariable,
    ttlSeconds?: number,
  ): Promise<{ saved: number }> {
    const mapped = Object.entries(variables).map(([fullKey, value]) => {
      const dot = fullKey.indexOf('.');
      return dot === -1
        ? { namespace: 'vars', key: fullKey, value }
        : {
            namespace: fullKey.slice(0, dot),
            key: fullKey.slice(dot + 1),
            value,
          };
    });

    const saved = await this.store.save(
      botConfigId,
      mapped,
      source,
      ttlSeconds,
    );

    this.eventBus.publish('variables.updated', {
      botConfigId,
      source,
      count: saved,
    });

    return { saved };
  }

  getVariables(botConfigId: string, namespace?: string) {
    return this.store.get(botConfigId, namespace);
  }

  deleteVariables(botConfigId: string, keys?: string[]) {
    return this.store.delete(botConfigId, keys);
  }

  async upsertMapping(
    botConfigId: string,
    eventType: string,
    rules: MappingRule,
    description?: string,
  ) {
    return this.mappings.upsert(botConfigId, eventType, rules, description);
  }

  getAllMappings(botConfigId: string) {
    return this.mappings.findAll(botConfigId);
  }

  deleteMapping(botConfigId: string, eventType: string) {
    return this.mappings.delete(botConfigId, eventType);
  }

  getEventHistory(botConfigId: string, limit = 50) {
    return this.prisma.externalDataEvent.findMany({
      where: { botConfigId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        eventType: true,
        source: true,
        processedAt: true,
        failedAt: true,
        error: true,
        createdAt: true,
      },
    });
  }
}
