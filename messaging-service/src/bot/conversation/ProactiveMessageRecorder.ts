import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from 'src/shared/prisma.service';
import {
  EVENT_TYPES,
  EventPayloadMap,
} from 'src/infra/events/constants/event.types';
import type { DomainEvent } from 'src/infra/events/interface/event.interface';
import { ConversationService } from './ConversationService';

/**
 * Copia en la conversación del bot los mensajes que el negocio envió por
 * fuera de él (recordatorios, avisos). Sin esto, si la clienta responde
 * "sí, confirmo" a un recordatorio, el bot no sabría qué está confirmando.
 * Solo aplica si la conexión tiene un bot asignado.
 */
@Injectable()
export class ProactiveMessageRecorder {
  private readonly logger = new Logger(ProactiveMessageRecorder.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly conversations: ConversationService,
  ) {}

  @OnEvent(EVENT_TYPES.PROACTIVE_MESSAGE_SENT)
  async record(
    event: DomainEvent<
      EventPayloadMap[typeof EVENT_TYPES.PROACTIVE_MESSAGE_SENT]
    >,
  ): Promise<void> {
    const { tenantId, connectionId, recipient, content } = event.payload;

    const connection = await this.prisma.whatsAppConnection.findFirst({
      where: { id: connectionId, tenantId },
      select: { botConfigId: true },
    });
    if (!connection?.botConfigId) return;

    try {
      await this.conversations.recordProactiveOutbound({
        tenantId,
        botConfigId: connection.botConfigId,
        phoneNumber: recipient,
        connectionId,
        content,
      });
    } catch (error) {
      this.logger.warn(
        `No fue posible registrar el mensaje proactivo a ${recipient} en su conversación: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
