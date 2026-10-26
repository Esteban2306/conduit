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
import { isBlank, splitBubbles } from 'src/bot/router/reply-guard';
import { ReplyMetricsService } from 'src/bot/router/reply-metrics.service';
import { OutboundReplyService } from '../outbox/OutboundReply.service';
import { OutboundReplyDispatcher } from '../outbox/OutboundReplyDispatcher';

@Injectable()
export class BaileysMessageSender {
  private readonly logger = new Logger(BaileysMessageSender.name);

  constructor(
    private readonly baileysPlugin: BaileysPlugin,
    private readonly conversationService: ConversationService,
    private readonly eventBus: EventBusService,
    private readonly replyMetrics: ReplyMetricsService,
    private readonly outbox: OutboundReplyService,
    private readonly dispatcher: OutboundReplyDispatcher,
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
      tenantId,
    } = event.payload;

    if (isBlank(content)) {
      this.replyMetrics.increment('blockedEmpty');
      this.logger.error(`Envío vacío bloqueado para ${phoneNumber}`);
      return { success: false, error: 'EMPTY_MESSAGE' };
    }

    if (sentBy !== 'human' && connectionId) {
      return this.queueReply({
        tenantId,
        connectionId,
        conversationId,
        phoneNumber,
        content,
        tokensUsed,
        imageVerified,
      });
    }

    try {
      const bubbles = sentBy === 'human' ? [content] : splitBubbles(content);
      const delivered: string[] = [];
      let result: Awaited<ReturnType<BaileysPlugin['send']>> | undefined;
      for (const bubble of bubbles) {
        result = await this.baileysPlugin.send({
          to: phoneNumber,
          content: bubble,
          subject: '',
          connectionId: connectionId ?? '',
          priority: 'conversation',
        });
        if (!result.success) break;
        delivered.push(bubble);
      }
      if (delivered.length > 0 && result && !result.success) {
        this.logger.error(
          `Se enviaron ${delivered.length} de ${bubbles.length} burbujas a ${phoneNumber}: ${result.error}`,
        );
        result = { ...result, success: true };
      }
      const savedContent =
        bubbles.length > 1 ? delivered.join('\n\n') : content;

      if (result?.success) {
        if (conversationId && sentBy === 'human') {
          // Queda como mensaje humano: activa la pausa por takeover del bot.
          await this.conversationService.saveHumanOutbound(
            conversationId,
            savedContent,
            connectionId ?? undefined,
          );
        } else if (conversationId) {
          await this.conversationService.saveOutbound(
            conversationId,
            savedContent,
            {
              tokensUsed,
              imageVerified,
              connectionId: connectionId ?? undefined,
            },
          );
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
        this.logger.error(`Fallo enviando a ${phoneNumber}: ${result?.error}`);
        this.eventBus.publish(EVENT_TYPES.CHANNEL_SEND_FAILED, {
          phoneNumber,
          error: result?.error ?? 'Error desconocido',
          retryable: result?.retryable ?? false,
        });
        return { success: false, error: result?.error };
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

  /**
   * Las respuestas del bot no se envían aquí: se guardan en la bandeja de
   * salida y el despachador las entrega en orden, con reintentos y caducidad.
   * Así una desconexión no las pierde ni las duplica.
   */
  private async queueReply(input: {
    tenantId?: string;
    connectionId: string;
    conversationId: string | null;
    phoneNumber: string;
    content: string;
    tokensUsed?: number;
    imageVerified?: boolean;
  }): Promise<{ success: boolean; error?: string }> {
    try {
      const tenantId =
        input.tenantId ?? (await this.outbox.tenantOf(input.connectionId));
      if (!tenantId) {
        return { success: false, error: 'CONNECTION_NOT_FOUND' };
      }
      await this.outbox.enqueue({
        tenantId,
        connectionId: input.connectionId,
        conversationId: input.conversationId,
        phoneNumber: input.phoneNumber,
        bubbles: splitBubbles(input.content),
        tokensUsed: input.tokensUsed,
        imageVerified: input.imageVerified,
      });
      this.dispatcher.kick();
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `No se pudo guardar la respuesta para ${input.phoneNumber} en la bandeja de salida: ${message}`,
      );
      return { success: false, error: message };
    }
  }
}
