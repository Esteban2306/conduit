import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { BaileysPlugin } from './BaileysPlugin';
import { ConversationService } from 'src/bot/conversation/ConversationService';
import {
  EVENT_TYPES,
  EventPayloadMap,
} from 'src/infra/events/constants/event.types';
import { EventBusService } from 'src/infra/events/event.service';
import type { DomainEvent } from 'src/infra/events/interface/event.interface';

@Injectable()
export class BaileysMessageSender {
  private readonly logger = new Logger(BaileysMessageSender.name);

  constructor(
    private readonly baileysPlugin: BaileysPlugin,
    private readonly conversationService: ConversationService,
    private readonly eventBus: EventBusService,
  ) {}

  @OnEvent(EVENT_TYPES.CHANNEL_SEND_REQUESTED)
  async handleSendRequested(
    event: DomainEvent<
      EventPayloadMap[typeof EVENT_TYPES.CHANNEL_SEND_REQUESTED]
    >,
  ): Promise<void> {
    const {
      phoneNumber,
      content,
      conversationId,
      connectionId,
      tokensUsed,
      imageVerified,
    } = event.payload;

    try {
      const result = await this.baileysPlugin.send({
        to: phoneNumber,
        content,
        subject: '',
        connectionId,
        priority: 'conversation',
      });

      if (result.success) {
        await this.conversationService.saveOutbound(conversationId, content, {
          tokensUsed,
          imageVerified,
        });

        this.eventBus.publish(EVENT_TYPES.CHANNEL_SEND_COMPLETED, {
          phoneNumber,
          providerMessageId: result.providerMessageId,
        });
      } else {
        this.logger.error(`Fallo enviando a ${phoneNumber}: ${result.error}`);
        this.eventBus.publish(EVENT_TYPES.CHANNEL_SEND_FAILED, {
          phoneNumber,
          error: result.error ?? 'Error desconocido',
          retryable: result.retryable ?? false,
        });
      }
    } catch (error) {
      this.logger.error(`Error en BaileysMessageSender: ${error.message}`);
      this.eventBus.publish(EVENT_TYPES.CHANNEL_SEND_FAILED, {
        phoneNumber,
        error: error instanceof Error ? error.message : 'Error desconocido',
        retryable: false,
      });
    }
  }
}
