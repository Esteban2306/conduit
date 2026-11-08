import { HttpException, Injectable, Logger } from '@nestjs/common';
import { DelayedError, Job } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import { MessageChannel, MessageStatus } from '@prisma/client';
import { PrismaService } from 'src/shared/prisma.service';
import { ChannelPluginFactory } from 'src/channels/factories/ChannelPluginFactory';
import { TemplateEngine } from 'src/core/templates/TemplateEngine';
import { TemplateService } from 'src/core/templates/TemplateService';
import { DLQHandler } from 'src/queue/Orchestrator/deadletter/DLQHandler';
import { ErrorClassifier } from 'src/core/errors/ErrorClassifier';
import { MessageJobPayload } from 'src/queue/queues';
import { WebhookDispatcher } from 'src/webhooks/WebhookDispatcher';
import { JobSigner, SignedJobPayload } from '../security/JobSigner';
import { EventBusService } from 'src/infra/events/event.service';
import { EVENT_TYPES } from 'src/infra/events/constants/event.types';
import { WhatsAppContactService } from 'src/channels/whatsapp/contacts/WhatsAppContactService';

const TERMINAL_STATUSES: MessageStatus[] = [
  MessageStatus.SENT,
  MessageStatus.DEAD,
  MessageStatus.CANCELLED,
];

const DISCONNECT_POLL_MS = 30_000;
const WAIT_TOUCH_MS = 10 * 60_000;
const MAX_DISCONNECT_WAIT_MS = 20 * 60 * 60_000;
const WAITING_NOTE = 'Esperando a que la línea de WhatsApp se reconecte';

@Injectable()
export class MessageProcessor {
  private readonly logger = new Logger(MessageProcessor.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly channelFactory: ChannelPluginFactory,
    private readonly templateService: TemplateService,
    private readonly templateEngine: TemplateEngine,
    private readonly dlqHandler: DLQHandler,
    private readonly webhookDispatcher: WebhookDispatcher,
    private readonly jobSigner: JobSigner,
    private readonly eventBus: EventBusService,
    private readonly contacts: WhatsAppContactService,
  ) {}

  async process(job: Job<SignedJobPayload>, token?: string): Promise<void> {
    const verification = this.jobSigner.verify(job.data);

    if (!verification.valid) {
      this.logger.error(
        `Job rechazado por seguridad: ${verification.reason} | jobId: ${job.id}`,
      );
      await this.dlqHandler.handle(
        job.data.messageId,
        verification.reason,
        'INVALID_JOB_SIGNATURE',
      );
      return;
    }
    const {
      messageId,
      tenantId,
      channel,
      recipient,
      templateId,
      connectionId,
      inlineBody,
      inlineSubject,
      variables,
      meta,
    } = job.data;
    const start = Date.now();

    const dbMessage = await this.prisma.message.findUnique({
      where: { id: messageId },
      select: {
        id: true,
        tenantId: true,
        connectionId: true,
        status: true,
        category: true,
        scheduledAt: true,
        updatedAt: true,
        lastError: true,
      },
    });

    if (!dbMessage || dbMessage.tenantId !== tenantId) {
      this.logger.error(
        `Inconsistencia de tenant: job.tenantId=${tenantId} no coincide con Message ${messageId}`,
      );
      await this.dlqHandler.handle(
        messageId,
        'Inconsistencia de tenant entre job y registro de Message',
        'TENANT_MISMATCH',
      );
      return;
    }

    if (TERMINAL_STATUSES.includes(dbMessage.status)) {
      this.logger.warn(
        `Job ${job.id} ignorado: Message ${messageId} ya está en estado terminal (${dbMessage.status})`,
      );
      return;
    }

    if (channel === MessageChannel.WHATSAPP) {
      if (!connectionId) {
        await this.dlqHandler.handle(
          messageId,
          'connectionId ausente para mensaje de WhatsApp',
          'MISSING_CONNECTION_ID',
        );
        return;
      }

      const connection = await this.prisma.whatsAppConnection.findFirst({
        where: { id: connectionId, tenantId },
        select: { id: true },
      });

      if (!connection) {
        this.logger.error(
          `connectionId ${connectionId} no pertenece al tenant ${tenantId}`,
        );
        await this.dlqHandler.handle(
          messageId,
          'La conexión de WhatsApp no pertenece a este tenant',
          'CONNECTION_TENANT_MISMATCH',
        );
        return;
      }

      if (
        dbMessage.category === 'MARKETING' &&
        (await this.contacts.isOptedOutForTenant(tenantId, recipient))
      ) {
        await this.cancelForOptOut(messageId);
        return;
      }

      const whatsapp = this.channelFactory.getPlugin(channel);
      if (
        token &&
        whatsapp.isAvailable &&
        !whatsapp.isAvailable(connectionId)
      ) {
        await this.waitForChannel(job, token, dbMessage);
        return;
      }
    }

    await this.updateMessageStatus(messageId, MessageStatus.PROCESSING);

    try {
      const { subject, body } = await this.resolveTemplate(
        templateId,
        inlineBody,
        inlineSubject,
        variables,
        tenantId,
        messageId,
      );
      const plugin = this.channelFactory.getPlugin(channel as MessageChannel);
      const result = await plugin.send({
        to: recipient,
        subject,
        content: body,
        connectionId,
        meta,
      });
      const durationMs = Date.now() - start;

      if (result.success) {
        await this.prisma.message.update({
          where: { id: messageId },
          data: {
            status: MessageStatus.SENT,
            sentAt: new Date(),
            resolvedAt: new Date(),
            provider: result.provider,
            providerMessageId: result.providerMessageId,
            renderedBody: body,
            renderedSubject: subject,
          },
        });
        await this.webhookDispatcher.dispatch('message.sent', messageId);
        if (channel === MessageChannel.WHATSAPP && connectionId) {
          // El bot debe saber qué se le envió al cliente (p. ej. un
          // recordatorio) para entender su respuesta.
          this.eventBus.publish(EVENT_TYPES.PROACTIVE_MESSAGE_SENT, {
            tenantId,
            connectionId,
            recipient,
            content: body,
          });
        }
        await this.logAttempt(
          messageId,
          job.attemptsMade + 1,
          'SENT',
          durationMs,
        );
      } else {
        if (token && result.errorCode === 'WHATSAPP_NOT_CONNECTED') {
          await this.waitForChannel(job, token, dbMessage);
          return;
        }

        const classified = ErrorClassifier.classify(
          result.errorCode ?? 'UNKNOWN',
          result.retryable ?? false,
        );

        await this.prisma.message.update({
          where: { id: messageId },
          data: {
            status: classified.retryable
              ? MessageStatus.FAILED
              : MessageStatus.DEAD,
            lastError: result.error,
            retryable: classified.retryable,
          },
        });

        await this.logAttempt(
          messageId,
          job.attemptsMade + 1,
          classified.retryable ? 'FAILED' : 'DEAD',
          durationMs,
          result.errorCode,
          result.error,
          classified.type as string,
        );

        if (!classified.retryable) {
          await this.dlqHandler.handle(
            messageId,
            result.error,
            result.errorCode,
          );
          return;
        }

        throw new Error(result.error ?? 'Send failed');
      }
    } catch (error) {
      if (error instanceof DelayedError) throw error;
      const durationMs = Date.now() - start;
      // Errores de validación previos al envío (plantilla inexistente o que
      // no renderiza): reintentar no los arregla.
      const isPermanent =
        error instanceof HttpException && error.getStatus() < 500;
      const isLastAttempt =
        isPermanent || job.attemptsMade + 1 >= (job.opts.attempts ?? 1);

      if (isLastAttempt) {
        await this.updateMessageStatus(
          messageId,
          MessageStatus.DEAD,
          error.message,
        );
        await this.dlqHandler.handle(
          messageId,
          error.message,
          isPermanent ? 'PERMANENT_PROCESSING_ERROR' : 'MAX_ATTEMPTS_EXCEEDED',
        );
      } else {
        await this.updateMessageStatus(
          messageId,
          MessageStatus.RETRYING,
          error.message,
        );
      }

      await this.logAttempt(
        messageId,
        job.attemptsMade + 1,
        isLastAttempt ? 'DEAD' : 'FAILED',
        durationMs,
        'PROCESSING_ERROR',
        error.message,
      );

      if (isPermanent) return;
      throw error;
    }
  }

  private disconnectWaitMs(): number {
    const configured = this.config.get<number>('queue.disconnectWaitMs');
    const wait = Number.isFinite(configured) ? (configured as number) : 0;
    return Math.min(Math.max(wait, 0), MAX_DISCONNECT_WAIT_MS);
  }

  /**
   * Con la línea desconectada el mensaje no es el que falla: se deja en
   * espera sin gastar intentos y se revisa de nuevo en unos segundos. Pasado
   * el tope se manda a la DLQ para que alguien lo revise, nunca se pierde.
   * Siempre lanza DelayedError salvo cuando agota el tope.
   */
  private async waitForChannel(
    job: Job<SignedJobPayload>,
    token: string,
    message: {
      id: string;
      status: MessageStatus;
      scheduledAt: Date;
      updatedAt: Date;
      lastError: string | null;
    },
  ): Promise<void> {
    const waitedMs = Date.now() - message.scheduledAt.getTime();
    const limitMs = this.disconnectWaitMs();

    if (waitedMs > limitMs) {
      await this.dlqHandler.handle(
        message.id,
        `La línea de WhatsApp estuvo desconectada más de ${Math.round(limitMs / 60_000)} minutos`,
        'WHATSAPP_DISCONNECT_TIMEOUT',
      );
      return;
    }

    const alreadyMarked =
      message.status === MessageStatus.RETRYING &&
      message.lastError === WAITING_NOTE &&
      Date.now() - message.updatedAt.getTime() < WAIT_TOUCH_MS;
    if (!alreadyMarked) {
      await this.prisma.message.update({
        where: { id: message.id },
        data: {
          status: MessageStatus.RETRYING,
          lastError: WAITING_NOTE,
          updatedAt: new Date(),
        },
      });
    }

    const pollMs =
      this.config.get<number>('queue.disconnectPollMs') ?? DISCONNECT_POLL_MS;
    const jitter = 0.8 + Math.random() * 0.4;
    await job.moveToDelayed(Date.now() + Math.round(pollMs * jitter), token);
    throw new DelayedError();
  }

  private async cancelForOptOut(messageId: string): Promise<void> {
    await this.prisma.message.update({
      where: { id: messageId },
      data: {
        status: MessageStatus.CANCELLED,
        retryable: false,
        lastError: 'El contacto pidió no recibir más mensajes de marketing',
        resolvedAt: new Date(),
      },
    });
    this.logger.warn(
      `Mensaje ${messageId} cancelado: el contacto se dio de baja antes del envío.`,
    );
    await this.webhookDispatcher.dispatch('message.cancelled', messageId);
  }

  private async resolveTemplate(
    templateId: string | undefined,
    inlineBody: string | undefined,
    inlineSubject: string | undefined,
    variables: Record<string, unknown>,
    tenantId: string,
    messageId: string,
  ): Promise<{ subject?: string; body: string }> {
    if (inlineBody)
      return this.templateEngine.render(inlineBody, variables, inlineSubject);
    if (templateId) {
      const template = await this.templateService.findOne(templateId, tenantId);
      return this.templateEngine.render(
        this.templateEngine.pickBody(
          template.bodyHandlebars,
          template.bodyVariants,
          messageId,
        ),
        variables,
        template.subject ?? undefined,
      );
    }
    throw new Error('No se encontró plantilla ni body inline');
  }

  private async updateMessageStatus(
    messageId: string,
    status: MessageStatus,
    lastError?: string,
  ): Promise<void> {
    await this.prisma.message.update({
      where: { id: messageId },
      data: {
        status,
        attempts: { increment: 1 },
        ...(lastError && { lastError }),
        updatedAt: new Date(),
      },
    });
  }

  private async logAttempt(
    messageId: string,
    attemptNumber: number,
    status: string,
    durationMs: number,
    errorCode?: string,
    errorDetail?: string,
    errorType?: string,
  ): Promise<void> {
    await this.prisma.messageAttempt.create({
      data: {
        messageId,
        attemptNumber,
        status,
        durationMs,
        errorCode,
        errorDetail,
        errorType: errorType ? (errorType as any) : undefined,
      },
    });
  }
}
