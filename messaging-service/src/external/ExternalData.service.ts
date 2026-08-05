import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/shared/prisma.service';
import { EventBusService } from 'src/infra/events/event.service';
import { VariableMapper } from './hooks/VariableMapper';
import { VariableStore } from './VariableStore';
import { MappingRepository } from './MappingRepository';
import { MappingRule } from './hooks/VariableMapper';
import { Prisma, SourceVariable } from '@prisma/client';
import { BotConfigService } from 'src/bot/config/BotConfigService';
import { computePayloadHash } from './utils/idempotency.util';

export interface ReceiveWebhookResult {
  received: boolean;
  eventId: string;
  mapped: number;
  duplicate: boolean;
}

@Injectable()
export class ExternalDataService {
  private readonly logger = new Logger(ExternalDataService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventBus: EventBusService,
    private readonly mapper: VariableMapper,
    private readonly store: VariableStore,
    private readonly mappings: MappingRepository,
    private readonly botConfigService: BotConfigService,
  ) {}

  async receiveWebhook(
    botConfigId: string,
    eventType: string,
    payload: Record<string, any>,
    externalEventId?: string,
  ): Promise<ReceiveWebhookResult> {
    try {
      await this.botConfigService.findOneForBot(botConfigId);
    } catch {
      throw new NotFoundException(`Bot ${botConfigId} no encontrado`);
    }

    const idempotencyKey = externalEventId
      ? `ext:${externalEventId}`
      : `hash:${computePayloadHash(eventType, payload)}`;

    const event = await this.createEventIdempotent(
      botConfigId,
      eventType,
      payload,
      idempotencyKey,
    );

    if (event.isDuplicate) {
      this.logger.debug(
        `Webhook duplicado ignorado: bot ${botConfigId}, eventType "${eventType}", clave ${idempotencyKey} (evento original: ${event.record.id})`,
      );
      return {
        received: true,
        eventId: event.record.id,
        mapped: event.record.mappedCount ?? 0,
        duplicate: true,
      };
    }

    const eventId = event.record.id;

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
        where: { id: eventId },
        data: { processedAt: new Date() },
      });

      this.eventBus.publish('external_data.processed', {
        eventId,
        botConfigId,
        eventType,
        mapped,
      });

      return { received: true, eventId, mapped, duplicate: false };
    } catch (err) {
      await this.prisma.externalDataEvent.update({
        where: { id: eventId },
        data: { failedAt: new Date(), error: err.message },
      });
      this.logger.error(`Error procesando webhook ${eventId}: ${err.message}`);
      throw err;
    }
  }

  async injectDirect(
    botConfigId: string,
    variables: Record<string, string>,
    source: SourceVariable,
    tenantId: string,
    ttlSeconds?: number,
  ): Promise<{ saved: number }> {
    await this.botConfigService.findOne(botConfigId, tenantId);
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

  async getVariables(
    botConfigId: string,
    tenantId: string,
    namespace?: string,
  ) {
    await this.botConfigService.findOne(botConfigId, tenantId);

    return this.store.get(botConfigId, namespace);
  }

  async deleteVariables(
    botConfigId: string,
    tenantId: string,
    keys?: string[],
  ) {
    await this.botConfigService.findOne(botConfigId, tenantId);

    return this.store.delete(botConfigId, keys);
  }

  async upsertMapping(
    botConfigId: string,
    eventType: string,
    rules: MappingRule,
    tenantId: string,
    description?: string,
  ) {
    await this.botConfigService.findOne(botConfigId, tenantId);

    return this.mappings.upsert(botConfigId, eventType, rules, description);
  }

  async getAllMappings(botConfigId: string, tenantId: string) {
    await this.botConfigService.findOne(botConfigId, tenantId);
    return this.mappings.findAll(botConfigId);
  }

  async deleteMapping(
    botConfigId: string,
    eventType: string,
    tenantId: string,
  ) {
    await this.botConfigService.findOne(botConfigId, tenantId);

    return this.mappings.delete(botConfigId, eventType);
  }

  async getEventHistory(botConfigId: string, tenantId: string, limit = 50) {
    await this.botConfigService.findOne(botConfigId, tenantId);
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

  private async createEventIdempotent(
    botConfigId: string,
    eventType: string,
    payload: Record<string, any>,
    idempotencyKey: string,
  ): Promise<
    | { isDuplicate: false; record: { id: string; mappedCount: number | null } }
    | { isDuplicate: true; record: { id: string; mappedCount: number | null } }
  > {
    try {
      const record = await this.prisma.externalDataEvent.create({
        data: {
          botConfigId,
          eventType,
          idempotencyKey,
          payload: payload as any,
          source: 'webhook',
        },
        select: { id: true, mappedCount: true },
      });
      return { isDuplicate: false, record };
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const existing = await this.prisma.externalDataEvent.findFirst({
          where: { botConfigId, idempotencyKey },
          select: { id: true, mappedCount: true },
        });
        if (existing) return { isDuplicate: true, record: existing };
      }
      throw err;
    }
  }
}
