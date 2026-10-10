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
  ): Promise<{ success: boolean; error?: string }> {
    const {
      phoneNumber,
      content,
      conversationId,
      connectionId,
      tokensUsed,
      imageVerified,
      sentBy,
    } = event.payload;

    try {
      const result = await this.baileysPlugin.send({
        to: phoneNumber,
        content,
        subject: '',
        connectionId: connectionId ?? '',
        priority: 'conversation',
      });

      if (result.success) {
        if (conversationId && sentBy === 'human') {
          // Queda como mensaje humano: activa la pausa por takeover del bot.
          await this.conversationService.saveHumanOutbound(
            conversationId,
            content,
            connectionId ?? undefined,
          );
        } else if (conversationId) {
          await this.conversationService.saveOutbound(conversationId, content, {
            tokensUsed,
            imageVerified,
            connectionId: connectionId ?? undefined,
          });
        } else {
          this.logger.debug(
            `Mensaje enviado a ${phoneNumber} sin conversationId — no se persiste en historial de conversación (envío administrativo/proactivo).`,
          );
        }

        this.eventBus.publish(EVENT_TYPES.CHANNEL_SEND_COMPLETED, {
          phoneNumber,
          providerMessageId: result.providerMessageId,
        });
        return { success: true };
      } else {
        this.logger.error(`Fallo enviando a ${phoneNumber}: ${result.error}`);
        this.eventBus.publish(EVENT_TYPES.CHANNEL_SEND_FAILED, {
          phoneNumber,
          error: result.error ?? 'Error desconocido',
          retryable: result.retryable ?? false,
        });
        return { success: false, error: result.error };
      }
    } catch (error) {
      this.logger.error(`Error en BaileysMessageSender: ${error.message}`);
      this.eventBus.publish(EVENT_TYPES.CHANNEL_SEND_FAILED, {
        phoneNumber,
        error: error instanceof Error ? error.message : 'Error desconocido',
        retryable: false,
      });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Error desconocido',
      };
    }
  }
}
