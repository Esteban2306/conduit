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
    const message =
      `⚠️ Fallo técnico en el bot\n\n` +
      `Herramienta: ${toolName}\n` +
      `Cliente afectado: ${clientPhoneNumber}\n` +
      `Detalle: ${errorDetail ?? 'sin detalle'}\n\n` +
      `El bot ya avisó al cliente que hubo un problema y que será contactado por una persona.`;

    return this.notifyContacts(
      tenantId,
      botConfigId,
      status,
      message,
      toolName,
    );
  }

  /**
   * La credencial de un modelo de IA fue rechazada (401/403). Se avisa una
   * sola vez por modelo hasta que se reactive o se vuelva a marcar.
   */
  async notifyAiCredentialInvalid(
    botConfigId: string,
    modelLabel: string,
    detail: string,
  ): Promise<boolean> {
    const bot = await this.prisma.botConfig.findUnique({
      where: { id: botConfigId },
      select: { tenantId: true },
    });
    if (!bot) return false;
    return this.notifyContacts(
      bot.tenantId,
      botConfigId,
      'TECHNICAL_ERROR',
      `⚠️ Credencial de IA rechazada\n\n` +
        `Modelo: ${modelLabel}\n` +
        `Detalle: ${detail || 'sin detalle'}\n\n` +
        `El modelo quedó fuera de uso hasta que se corrija la clave y se reactive desde el panel. Si hay un respaldo configurado, el bot sigue respondiendo con él.`,
      'credencial de IA',
    );
  }

  async notifyContacts(
    tenantId: string,
    botConfigId: string,
    status: ToolInvocationStatus,
    message: string,
    subject: string,
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
        `Aviso "${subject}" sin ningún contacto de escalamiento configurado para el bot ${botConfigId}: NADIE fue notificado.`,
      );
      return false;
    }

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
        `Aviso "${subject}": ningún contacto de escalamiento pudo ser notificado (bot ${botConfigId}).`,
      );
    }
    return dispatched > 0;
  }
}
