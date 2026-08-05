import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from 'src/shared/prisma.service';
import { EventBusService } from 'src/infra/events/event.service';
import { VariableMapper } from './hooks/VariableMapper';
import { VariableStore } from './VariableStore';
import { MappingRepository } from './MappingRepository';
import { MappingRule } from './hooks/VariableMapper';
import { Prisma, SourceVariable } from '@prisma/client';
import { BotConfigService } from 'src/bot/config/BotConfigService';
import { computePayloadHash } from './utils/idempotency.util';
import { WhatsAppConnectionService } from 'src/channels/whatsapp/WhatsAppConnection.service';
import { TemplateService } from 'src/core/templates/TemplateService';
import { WebhookAction } from './hooks/webhook-action.types';
import { getNestedValue } from 'src/shared/utils/nested-value.util';
import { EVENT_TYPES } from 'src/infra/events/constants/event.types';

export interface ReceiveWebhookResult {
  received: boolean;
  eventId: string;
  mapped: number;
  duplicate: boolean;
  actionTriggered: boolean;
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
    private readonly connections: WhatsAppConnectionService,
    private readonly templateService: TemplateService,
  ) {}

  async receiveWebhook(
    botConfigId: string,
    eventType: string,
    payload: Record<string, any>,
    externalEventId?: string,
  ): Promise<ReceiveWebhookResult> {
    const botConfig = await this.botConfigService
      .findOneForBot(botConfigId)
      .catch(() => {
        throw new NotFoundException(`Bot ${botConfigId} no encontrado`);
      });

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
        actionTriggered: false,
      };
    }

    const eventId = event.record.id;

    try {
      const full = await this.mappings.findFull(botConfigId, eventType);

      let mapped = 0;
      if (full?.rules) {
        const variables = this.mapper.map(full.rules, payload);
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

      let actionTriggered = false;
      if (full?.action?.enabled) {
        actionTriggered = await this.tryTriggerAction(
          full.action,
          payload,
          botConfig.tenantId,
        );
      }

      return {
        received: true,
        eventId,
        mapped,
        duplicate: false,
        actionTriggered,
      };
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
    action?: WebhookAction,
  ) {
    await this.botConfigService.findOne(botConfigId, tenantId);

    if (action?.enabled) {
      await this.validateAction(action, tenantId);
    }

    return this.mappings.upsert(
      botConfigId,
      eventType,
      rules,
      description,
      action,
    );
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

  private async tryTriggerAction(
    action: WebhookAction,
    payload: Record<string, any>,
    tenantId: string,
  ): Promise<boolean> {
    try {
      const recipient = getNestedValue(payload, action.recipientField);
      if (!recipient || typeof recipient !== 'string') {
        this.logger.warn(
          `Acción de webhook: recipientField "${action.recipientField}" no resolvió a un valor válido. Acción omitida.`,
        );
        return false;
      }

      let scheduledAt: string | undefined;
      if (action.scheduleField) {
        const rawDate = getNestedValue(payload, action.scheduleField);
        const baseDate = rawDate ? new Date(String(rawDate)) : null;

        if (!baseDate || Number.isNaN(baseDate.getTime())) {
          this.logger.warn(
            `Acción de webhook: scheduleField "${action.scheduleField}" no es una fecha válida ("${rawDate}"). Acción omitida — no se envía a ciegas sin fecha correcta.`,
          );
          return false;
        }

        const offsetMs = (action.scheduleOffsetMinutes ?? 0) * 60_000;
        scheduledAt = new Date(baseDate.getTime() + offsetMs).toISOString();
      }

      this.eventBus.publish(EVENT_TYPES.WEBHOOK_ACTION_TRIGGERED, {
        tenantId,
        connectionId: action.connectionId,
        recipient,
        templateId: action.templateId,
        inlineBody: action.inlineBody,
        variables: payload,
        scheduledAt,
        priority: action.priority,
      });

      return true;
    } catch (err) {
      this.logger.error(`Error preparando acción de webhook: ${err.message}`);
      return false;
    }
  }

  private async validateAction(
    action: WebhookAction,
    tenantId: string,
  ): Promise<void> {
    await this.connections.findOne(action.connectionId, tenantId);

    if (!action.templateId && !action.inlineBody) {
      throw new BadRequestException(
        'La acción requiere templateId o inlineBody.',
      );
    }

    if (action.templateId) {
      const template = await this.templateService
        .findOne(action.templateId, tenantId)
        .catch(() => null);
      if (!template) {
        throw new BadRequestException(
          `Template ${action.templateId} no encontrado o inactivo para este tenant.`,
        );
      }
    }
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
