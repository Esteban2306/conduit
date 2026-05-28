import { Injectable, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import { MessageChannel, MessageStatus } from '@prisma/client';
import { PrismaService } from 'src/shared/prisma.service';
import { ChannelPluginFactory } from 'src/channels/factories/ChannelPluginFactory';
import { TemplateEngine } from 'src/core/templates/TemplateEngine';
import { TemplateService } from 'src/core/templates/TemplateService';
import { DLQHandler } from 'src/queue/Orchestrator/deadletter/DLQHandler';
import { ErrorClassifier } from 'src/core/errors/ErrorClassifier';
import { MessageJobPayload } from 'src/queue/queues';

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
  ) {}

  async process(job: Job<MessageJobPayload>): Promise<void> {
    const {
      messageId,
      channel,
      recipient,
      templateId,
      inlineBody,
      inlineSubject,
      variables,
      meta,
    } = job.data;
    const start = Date.now();

    await this.updateMessageStatus(messageId, MessageStatus.PROCESSING);

    try {
      const { subject, body } = await this.resolveTemplate(
        templateId,
        inlineBody,
        inlineSubject,
        variables,
      );
      const plugin = this.channelFactory.getPlugin(channel as MessageChannel);
      const result = await plugin.send({
        to: recipient,
        subject,
        content: body,
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
        await this.logAttempt(
          messageId,
          job.attemptsMade + 1,
          'SENT',
          durationMs,
        );
      } else {
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
      const durationMs = Date.now() - start;
      const maxAttempts = this.config.get<number>('queue.maxAttempts') ?? 3;
      const isLastAttempt = job.attemptsMade + 1 >= maxAttempts;

      if (isLastAttempt) {
        await this.updateMessageStatus(
          messageId,
          MessageStatus.DEAD,
          error.message,
        );
        await this.dlqHandler.handle(
          messageId,
          error.message,
          'MAX_ATTEMPTS_EXCEEDED',
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

      throw error;
    }
  }

  private async resolveTemplate(
    templateId: string | undefined,
    inlineBody: string | undefined,
    inlineSubject: string | undefined,
    variables: Record<string, unknown>,
  ): Promise<{ subject?: string; body: string }> {
    if (inlineBody)
      return this.templateEngine.render(inlineBody, variables, inlineSubject);
    if (templateId) {
      const template = await this.templateService.findOne(templateId);
      return this.templateEngine.render(
        template.bodyHandlebars,
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
