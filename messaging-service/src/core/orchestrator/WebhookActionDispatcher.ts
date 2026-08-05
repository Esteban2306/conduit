import { Injectable, Logger } from '@nestjs/common';
import { MessageOrchestrator } from './MessageOrchestrator';
import { OnEvent } from '@nestjs/event-emitter';
import {
  EVENT_TYPES,
  EventPayloadMap,
} from 'src/infra/events/constants/event.types';
import type { DomainEvent } from 'src/infra/events/interface/event.interface';

@Injectable()
export class WebhookActionDispatcher {
  private readonly logger = new Logger(WebhookActionDispatcher.name);
  constructor(private readonly orchestrator: MessageOrchestrator) {}

  @OnEvent(EVENT_TYPES.WEBHOOK_ACTION_TRIGGERED)
  async handle(
    event: DomainEvent<
      EventPayloadMap[typeof EVENT_TYPES.WEBHOOK_ACTION_TRIGGERED]
    >,
  ): Promise<void> {
    const {
      tenantId,
      connectionId,
      recipient,
      templateId,
      inlineBody,
      variables,
      scheduledAt,
      priority,
    } = event.payload;

    try {
      await this.orchestrator.dispatch(tenantId, {
        recipient: { channel: 'WHATSAPP', address: recipient },
        template: templateId
          ? { id: templateId }
          : { inline: { body: inlineBody } },
        connectionId,
        variables,
        options: { scheduledAt, priority },
      });

      this.logger.log(
        `Acción de webhook encolada: destinatario ${recipient}` +
          (scheduledAt ? ` | programado para ${scheduledAt}` : ' | inmediato'),
      );
    } catch (error) {
      this.logger.error(
        `No fue posible encolar la acción de webhook para ${recipient}: ${error.message}`,
      );
    }
  }
}
