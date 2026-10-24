import { Injectable, Logger } from '@nestjs/common';
import { ToolInvocationStatus } from '@prisma/client';
import { MessageOrchestrator } from 'src/core/orchestrator/MessageOrchestrator';
import { EVENT_TYPES } from 'src/infra/events/constants/event.types';
import { EventBusService } from 'src/infra/events/event.service';
import { PrismaService } from 'src/shared/prisma.service';

@Injectable()
export class BotEscalationService {
  private readonly logger = new Logger(BotEscalationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly orchestrator: MessageOrchestrator,
  ) {}

  async notifyToolFailure(
    tenantId: string,
    botConfigId: string,
    status: ToolInvocationStatus,
    toolName: string,
    clientPhoneNumber: string,
    errorDetail: string | null,
  ): Promise<boolean> {
    const contacts = await this.prisma.botEscalationContact.findMany({
      where: { botConfigId },
    });

    const relevant = contacts.filter((c) => {
      const triggers = (c.notifyOn as string[]) ?? ['TECHNICAL_ERROR'];
      return triggers.includes(status);
    });

    if (relevant.length === 0) {
      this.logger.error(
        `Fallo en "${toolName}" sin ningún contacto de escalamiento configurado para el bot ${botConfigId}: NADIE fue notificado.`,
      );
      return false;
    }

    const message =
      `⚠️ Fallo técnico en el bot\n\n` +
      `Herramienta: ${toolName}\n` +
      `Cliente afectado: ${clientPhoneNumber}\n` +
      `Detalle: ${errorDetail ?? 'sin detalle'}\n\n` +
      `El bot ya avisó al cliente que hubo un problema y que será contactado por una persona.`;

    let dispatched = 0;
    for (const contact of relevant) {
      if (!contact.connectionId) {
        this.logger.error(
          `Contacto de escalamiento "${contact.label}" (bot ${botConfigId}) no tiene connectionId configurado — no se puede notificar por WhatsApp.`,
        );
        continue;
      }

      try {
        await this.orchestrator.dispatch(tenantId, {
          recipient: { channel: 'WHATSAPP', address: contact.phoneNumber },
          template: { inline: { body: message } },
          connectionId: contact.connectionId,
          variables: {},
          options: { priority: 'high' },
        });
        dispatched += 1;
      } catch (err) {
        this.logger.error(
          `No fue posible notificar al contacto de escalamiento "${contact.label}": ${err.message}`,
        );
      }
    }

    if (dispatched === 0) {
      this.logger.error(
        `Fallo en "${toolName}": ningún contacto de escalamiento pudo ser notificado (bot ${botConfigId}).`,
      );
    }
    return dispatched > 0;
  }
}
