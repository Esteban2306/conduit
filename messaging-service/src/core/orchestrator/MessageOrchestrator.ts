import { InjectQueue } from '@nestjs/bullmq';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Param,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Message, MessageChannel, MessageStatus, Prisma } from '@prisma/client';
import { Queue } from 'bullmq';
import {
  jobPayloadFromMessage,
  messageJobId,
  MessageJobPayload,
  QUEUE_NAMES,
} from 'src/queue/queues';
import { PrismaService } from 'src/shared/prisma.service';
import { TemplateService } from '../templates/TemplateService';
import {
  DataAdapterValidationError,
  DataAdapterValidator,
} from '../adapters/DataAdapterValidator';
import { MessagePayload } from '../adapters/IDataAdapter';
import { ListMessageDto } from './dto/list-messages.dto';
import { JobSigner } from 'src/queue/security/JobSigner';
import { BulkDispatchDto } from './dto/bulk-dispatch.dto';
import { FileDispatchDto } from './dto/file-dispatch.dto';
import { FileParserService } from '../adapters/FileParserService';
import { BatchResult } from './type/batch-result.type';
import { normalizeWhatsAppAddress } from 'src/channels/whatsapp/utils/whatsapp-address.util';
import { WebhookDispatcher } from 'src/webhooks/WebhookDispatcher';
import { WhatsAppContactService } from 'src/channels/whatsapp/contacts/WhatsAppContactService';

export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

export interface DispatchResult {
  messageId: string;
  status: string;
  /** true cuando la clave de idempotencia ya existía: no se creó un mensaje nuevo. */
  duplicate: boolean;
}

export interface DispatchOptions {
  /** Clave del integrador; reintentos con la misma clave devuelven el mismo mensaje. */
  idempotencyKey?: string;
}

export interface DuplicateInfo {
  index: number;
  address: string;
}

@Injectable()
export class MessageOrchestrator {
  private readonly logger = new Logger(MessageOrchestrator.name);

  constructor(
    @InjectQueue(QUEUE_NAMES.MESSAGES)
    private readonly messageQueue: Queue<MessageJobPayload>,
    @InjectQueue(QUEUE_NAMES.MESSAGES_SCHEDULED)
    private readonly scheduledQueue: Queue<MessageJobPayload>,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly templateService: TemplateService,
    private readonly jobSigner: JobSigner,
    private readonly fileParser: FileParserService,
    private readonly webhookDispatcher: WebhookDispatcher,
    private readonly contacts: WhatsAppContactService,
  ) {}

  async dispatch(
    tenantId: string,
    raw: unknown,
    options: DispatchOptions = {},
  ): Promise<DispatchResult> {
    if (
      options.idempotencyKey !== undefined &&
      !IDEMPOTENCY_KEY_PATTERN.test(options.idempotencyKey)
    ) {
      throw new BadRequestException(
        'Idempotency-Key inválida: usa 8-128 caracteres [A-Za-z0-9._:-].',
      );
    }

    if (options.idempotencyKey) {
      const existing = await this.findByIdempotencyKey(
        tenantId,
        options.idempotencyKey,
      );
      if (existing) return this.resumeExisting(existing);
    }

    const payload = await this.validatePayload(tenantId, raw);

    return this.commitDispatch(tenantId, payload, options.idempotencyKey);
  }

  async dispatchBatch(
    tenantId: string,
    raws: unknown[],
    strict = false,
  ): Promise<BatchResult> {
    if (strict) {
      return this.dispatchBatchStrict(tenantId, raws);
    }

    if (raws.length <= this.BATCH_CHUNK_SIZE) {
      return this.processBatchDirect(tenantId, raws);
    }

    return this.processBatchInChunks(tenantId, raws);
  }

  async dispatchBulk(
    tenantId: string,
    dto: BulkDispatchDto,
  ): Promise<BatchResult & { duplicatesSkipped: DuplicateInfo[] }> {
    const template = await this.resolveTemplate(dto.templateId, tenantId);

    const { unique, duplicates } = this.dedupeBy(
      dto.recipients,
      (r) => r.address,
    );

    const payloads = unique.map((r) => ({
      recipient: {
        channel: template.channel,
        address: r.address,
        name: r.name,
      },
      template: { id: dto.templateId },
      connectionId: dto.connectionId,
      variables: r.variables,
      options: dto.options,
    }));

    const result = await this.dispatchBatch(tenantId, payloads);

    return { ...result, duplicatesSkipped: duplicates };
  }

  async dispatchFromFile(
    tenantId: string,
    file: Express.Multer.File,
    dto: FileDispatchDto,
  ) {
    const parsed = this.fileParser.parse(
      file.buffer,
      file.mimetype,
      file.originalname,
    );

    if (parsed.errors.length > 0) {
      throw new BadRequestException({
        message: `${parsed.errors.length} fila(s) del archivo tienen errores de formato.`,
        parseErrors: parsed.errors,
      });
    }

    const { unique, duplicates } = this.dedupeBy(parsed.rows, (row) =>
      String(row.address ?? ''),
    );

    const payloads = this.fileParser.rowsToPayloads(
      unique,
      dto.templateId,
      dto.extraVariables ?? {},
      dto.scheduledAt ?? '',
      dto.priority,
      dto.connectionId,
    );

    const result = await this.dispatchBatch(tenantId, payloads);

    return {
      ...result,
      duplicatesSkipped: duplicates,
      fileInfo: {
        fileName: file.originalname,
        totalRows: parsed.totalRows,
        headers: parsed.headers,
      },
    };
  }

  async getStatus(messageId: string, tenantId: string) {
    const message = await this.prisma.message.findUnique({
      where: { id: messageId, tenantId },
      include: {
        attemptLogs: { orderBy: { createdAt: 'desc' } },
        deadLetter: true,
      },
    });

    if (!message) {
      throw new NotFoundException(`Mensaje ${messageId} no encontrado`);
    }

    return {
      messageId: message.id,
      channel: message.channel,
      recipient: message.recipient,
      status: message.status,
      attempts: message.attempts,
      maxAttempts: message.maxAttempts,
      scheduledAt: message.scheduledAt,
      sentAt: message.sentAt,
      resolvedAt: message.resolvedAt,
      provider: message.provider,
      providerMessageId: message.providerMessageId,
      lastError: message.lastError,
      retryable: message.retryable,
      attemptLogs: message.attemptLogs,
      deadLetter: message.deadLetter ?? null,
    };
  }

  async cancel(
    messageId: string,
    tenantId: string,
  ): Promise<{ messageId: string; status: string }> {
    const message = await this.prisma.message.findUnique({
      where: { id: messageId, tenantId },
    });

    if (!message) {
      throw new NotFoundException(`Mensaje ${messageId} no encontrado`);
    }

    const cancellable: MessageStatus[] = [
      MessageStatus.PENDING,
      MessageStatus.QUEUED,
      MessageStatus.FAILED,
    ];

    if (!cancellable.includes(message.status as MessageStatus)) {
      throw new BadRequestException(
        `El mensaje en estado ${message.status} no puede cancelarse`,
      );
    }

    for (const queue of [this.messageQueue, this.scheduledQueue]) {
      const job = await queue.getJob(messageJobId(messageId));
      if (job && !(await job.isActive())) await job.remove();
    }

    const { count } = await this.prisma.message.updateMany({
      where: { id: messageId, status: { in: cancellable } },
      data: {
        status: MessageStatus.CANCELLED,
        resolvedAt: new Date(),
      },
    });

    if (count === 0) {
      throw new BadRequestException(
        `El mensaje ${messageId} cambió de estado mientras se cancelaba y no puede cancelarse`,
      );
    }

    this.logger.log(`Mensaje cancelado: ${messageId}`);
    await this.webhookDispatcher.dispatch('message.cancelled', messageId);

    return { messageId, status: MessageStatus.CANCELLED };
  }

  async listMessage(tenantId: string, filter: ListMessageDto) {
    const {
      queue = 'all',
      status,
      channel,
      scheduledFrom,
      scheduledTo,
      recipient,
      page = 1,
      limit = 20,
    } = filter;

    const skip = (page - 1) * limit;
    const now = new Date();

    const queueFilter =
      queue === 'immediate'
        ? { scheduledAt: { lte: now } }
        : queue === 'scheduled'
          ? { scheduledAt: { gt: now } }
          : {};

    const scheduledRangeFilter =
      scheduledFrom || scheduledTo
        ? {
            scheduledAt: {
              ...(scheduledFrom && { gte: new Date(scheduledFrom) }),
              ...(scheduledTo && { lte: new Date(scheduledTo) }),
            },
          }
        : {};

    const where = {
      tenantId,
      ...queueFilter,
      ...scheduledRangeFilter,
      ...(status && { status: status as MessageStatus }),
      ...(channel && { channel: channel as unknown as MessageChannel }),
      ...(recipient && {
        recipient: { contains: recipient, mode: 'insensitive' as const },
      }),
    };

    const [message, total] = await Promise.all([
      this.prisma.message.findMany({
        where,
        orderBy: { scheduledAt: 'asc' },
        skip,
        take: limit,
        select: {
          id: true,
          channel: true,
          recipient: true,
          status: true,
          attemptLogs: true,
          maxAttempts: true,
          scheduledAt: true,
          sentAt: true,
          resolvedAt: true,
          provider: true,
          lastError: true,
          retryable: true,
          createdAt: true,
          template: { select: { id: true, name: true } },
        },
      }),
      this.prisma.message.count({ where }),
    ]);

    const enriched = message.map((msg) => {
      const isScheduled = msg.scheduledAt > now;
      const minutesUntilSend = isScheduled
        ? Math.round((msg.scheduledAt.getTime() - now.getTime()) / 60000)
        : null;

      return {
        ...msg,
        queue: isScheduled ? 'scheduled' : 'immediate',
        minutesUntilSend,
        isOverdue:
          !isScheduled &&
          msg.status !== MessageStatus.SENT &&
          msg.status !== MessageStatus.DEAD &&
          msg.status !== MessageStatus.CANCELLED,
      };
    });

    return {
      data: enriched,
      meta: {
        total,
        page,
        limit,
        totalPage: Math.ceil(total / limit),
        filter: {
          queue,
          status: status ?? 'all',
          channel: channel ?? 'all',
        },
      },
    };
  }

  private readonly BATCH_CHUNK_SIZE = 50;

  private async validatePayload(
    tenantId: string,
    raw: unknown,
  ): Promise<MessagePayload> {
    const payload = this.parsePayload(raw);

    if (payload.template.id) {
      await this.validateTemplate(payload.template.id, tenantId);
    }

    this.validateChannel(payload.recipient.channel);

    if (payload.recipient.channel === 'WHATSAPP') {
      const address = normalizeWhatsAppAddress(payload.recipient.address);
      if (!address) {
        throw new BadRequestException(
          `recipient.address "${payload.recipient.address}" no es un número de WhatsApp válido. ` +
            'Usa formato internacional con código de país (ej. +573001234567 o 573001234567).',
        );
      }
      payload.recipient.address = address;

      if (!payload.connectionId) {
        throw new BadRequestException(
          'connectionId es obligatorio para mensajes del canal WHATSAPP. ' +
            'Este tenant puede tener múltiples conexiones activas; especifica cuál usar.',
        );
      }
      await this.validateConnection(payload.connectionId, tenantId);

      // Se valida al encolar para que el integrador reciba el motivo de
      // inmediato; el plugin lo vuelve a verificar al enviar.
      const gate = await this.contacts.campaignGate(
        payload.connectionId,
        address,
      );
      if (!gate.allowed) {
        throw new BadRequestException({
          code: 'RECIPIENT_NOT_OPTED_IN',
          message:
            `${gate.reason}. Por política anti-bloqueo, este WhatsApp solo inicia ` +
            'mensajes con números que le escribieron antes (configurable por conexión).',
        });
      }
    }

    return payload;
  }

  private async commitDispatch(
    tenantId: string,
    payload: MessagePayload,
    idempotencyKey?: string,
  ): Promise<DispatchResult> {
    const scheduledAt = payload.options?.scheduledAt
      ? new Date(payload.options.scheduledAt)
      : new Date();

    let message: Message;
    try {
      message = await this.prisma.message.create({
        data: {
          tenantId,
          channel: payload.recipient.channel,
          recipient: payload.recipient.address,
          connectionId: payload.connectionId ?? null,
          templateId: payload.template.id ?? null,
          variables: (payload.variables ?? {}) as Prisma.InputJsonValue,
          meta: payload.meta
            ? (payload.meta as Prisma.InputJsonValue)
            : Prisma.JsonNull,
          idempotencyKey: idempotencyKey ?? null,
          status: MessageStatus.PENDING,
          scheduledAt,
          maxAttempts: this.config.get<number>('queue.maxAttempts') ?? 5,
          renderedSubject: payload.template.inline?.subject ?? '',
          renderedBody: payload.template.inline?.body ?? '',
        },
      });
    } catch (error) {
      if (
        idempotencyKey &&
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const existing = await this.findByIdempotencyKey(
          tenantId,
          idempotencyKey,
        );
        if (existing) return this.resumeExisting(existing);
      }
      throw error;
    }

    await this.enqueue(
      {
        messageId: message.id,
        tenantId,
        channel: payload.recipient.channel,
        recipient: payload.recipient.address,
        connectionId: payload.connectionId,
        templateId: payload.template.id ?? '',
        inlineBody: payload.template.inline?.body ?? '',
        inlineSubject: payload.template.inline?.subject ?? '',
        variables: payload.variables ?? {},
        meta: payload.meta,
        sheduledAt: payload.options?.scheduledAt,
      },
      scheduledAt,
      payload.options?.priority,
    );

    return {
      messageId: message.id,
      status: MessageStatus.QUEUED,
      duplicate: false,
    };
  }

  /**
   * Encola el job del mensaje. Es seguro llamarlo varias veces para el mismo
   * mensaje: el jobId es determinista y BullMQ descarta el duplicado.
   */
  async enqueue(
    jobPayload: MessageJobPayload,
    scheduledAt: Date,
    priority: 'low' | 'normal' | 'high' = 'normal',
  ): Promise<void> {
    const delayMs = scheduledAt.getTime() - Date.now();
    const isScheduled = delayMs > 1000;

    const targetQueue = isScheduled ? this.scheduledQueue : this.messageQueue;
    const signedPayload = this.jobSigner.sign({ ...jobPayload, isScheduled });

    const job = await targetQueue.add(
      `message:${jobPayload.channel}`,
      signedPayload,
      this.buildJobOptions(jobPayload.messageId, priority, delayMs),
    );

    // Solo PENDING → QUEUED: un worker rápido pudo haberlo procesado ya y no
    // se debe pisar su estado (p. ej. devolver un SENT a QUEUED).
    await this.prisma.message.updateMany({
      where: { id: jobPayload.messageId, status: MessageStatus.PENDING },
      data: { status: MessageStatus.QUEUED },
    });

    this.logger.log(
      `Mensaje encolado: ${jobPayload.messageId} | Canal: ${jobPayload.channel} | Job: ${job.id}`,
    );
  }

  private findByIdempotencyKey(tenantId: string, idempotencyKey: string) {
    return this.prisma.message.findUnique({
      where: { tenantId_idempotencyKey: { tenantId, idempotencyKey } },
    });
  }

  private async resumeExisting(existing: Message): Promise<DispatchResult> {
    if (existing.status === MessageStatus.PENDING) {
      // El intento anterior creó el registro pero no alcanzó a encolarlo.
      await this.enqueue(jobPayloadFromMessage(existing), existing.scheduledAt);
      return {
        messageId: existing.id,
        status: MessageStatus.QUEUED,
        duplicate: true,
      };
    }

    return { messageId: existing.id, status: existing.status, duplicate: true };
  }

  private async dispatchBatchStrict(
    tenantId: string,
    raws: unknown[],
  ): Promise<BatchResult> {
    const validations = await Promise.allSettled(
      raws.map((r) => this.validatePayload(tenantId, r)),
    );

    const validationFailures: Array<{ index: number; error: string }> = [];
    validations.forEach((result, index) => {
      if (result.status === 'rejected') {
        validationFailures.push({
          index,
          error: result.reason?.message ?? 'Error desconocido',
        });
      }
    });

    if (validationFailures.length > 0) {
      throw new BadRequestException({
        message:
          `${validationFailures.length} de ${raws.length} mensajes no pasaron ` +
          'validación. Modo estricto: no se encoló ningún mensaje del lote.',
        failed: validationFailures,
      });
    }

    const payloads = validations.map(
      (r) => (r as PromiseFulfilledResult<MessagePayload>).value,
    );

    const results = await Promise.allSettled(
      payloads.map((payload) => this.commitDispatch(tenantId, payload)),
    );

    return this.buildBatchResult(results);
  }

  private dedupeBy<T>(
    items: T[],
    keyExtractor: (item: T) => string,
  ): { unique: T[]; duplicates: DuplicateInfo[] } {
    const seen = new Set<string>();
    const unique: T[] = [];
    const duplicates: DuplicateInfo[] = [];

    items.forEach((item, index) => {
      const rawKey = keyExtractor(item);
      const key = rawKey.trim().toLowerCase();

      if (seen.has(key)) {
        duplicates.push({ index, address: rawKey });
        return;
      }

      seen.add(key);
      unique.push(item);
    });

    return { unique, duplicates };
  }

  private async processBatchDirect(
    tenantId: string,
    raws: unknown[],
  ): Promise<{
    total: number;
    queued: number;
    failed: Array<{ index: number; error: string }>;
  }> {
    const results = await Promise.allSettled(
      raws.map((raw) => this.dispatch(tenantId, raw)),
    );

    return this.buildBatchResult(results);
  }

  private async processBatchInChunks(
    tenantId: string,
    raws: unknown[],
  ): Promise<{
    total: number;
    queued: number;
    failed: Array<{ index: number; error: string }>;
  }> {
    const chunks = this.chunkArray(raws, this.BATCH_CHUNK_SIZE);

    const allResults: PromiseSettledResult<{
      messageId: string;
      status: string;
    }>[] = [];

    for (const chunk of chunks) {
      const chunkResults = await Promise.allSettled(
        chunk.map((raw) => this.dispatch(tenantId, raw)),
      );
      allResults.push(...chunkResults);

      this.logger.log(
        `Chunk procesado: ${allResults.length}/${raws.length} mensajes`,
      );
    }

    return this.buildBatchResult(allResults);
  }

  private chunkArray<T>(array: T[], chunkSize: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += chunkSize) {
      chunks.push(array.slice(i, i + chunkSize));
    }
    return chunks;
  }

  private buildBatchResult(
    results: PromiseSettledResult<{ messageId: string; status: string }>[],
  ): {
    total: number;
    queued: number;
    failed: Array<{ index: number; error: string }>;
  } {
    const failed: Array<{ index: number; error: string }> = [];

    let queued = 0;

    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        queued++;
      } else {
        failed.push({
          index,
          error: result.reason.message ?? 'Error desconocido',
        });
      }
    });

    this.logger.log(`Batch completado: ${queued}/${results.length} encolados`);

    return { total: results.length, queued, failed };
  }

  private async validateTemplate(
    templateId: string,
    tenantId: string,
  ): Promise<void> {
    try {
      await this.templateService.findOne(templateId, tenantId);
    } catch {
      throw new NotFoundException(
        `Template ${templateId} no encontrado o inactivo`,
      );
    }
  }

  private parsePayload(raw: unknown): MessagePayload {
    try {
      return DataAdapterValidator.validate(raw);
    } catch (error) {
      if (error instanceof DataAdapterValidationError) {
        throw new BadRequestException({
          message: 'El payload del mensaje no cumple el formato esperado.',
          errors: error.errors,
        });
      }
      throw error;
    }
  }

  private async resolveTemplate(templateId: string, tenantId: string) {
    try {
      return await this.templateService.findOne(templateId, tenantId);
    } catch {
      throw new NotFoundException(
        `Template ${templateId} no encontrado o inactivo`,
      );
    }
  }

  private validateChannel(channel: string): void {
    const supported = Object.values(MessageChannel);
    if (!supported.includes(channel as MessageChannel)) {
      throw new BadRequestException(
        `Canal no soportado: ${channel}. Opciones: ${supported.join(', ')}`,
      );
    }
  }

  private async validateConnection(
    connectionId: string,
    tenantId: string,
  ): Promise<void> {
    const connection = await this.prisma.whatsAppConnection.findFirst({
      where: { id: connectionId, tenantId },
      select: { id: true },
    });

    if (!connection) {
      throw new NotFoundException(
        `Conexión de WhatsApp ${connectionId} no encontrada para este tenant.`,
      );
    }
  }

  private buildJobOptions(
    messageId: string,
    priority: 'low' | 'normal' | 'high',
    delayMs: number,
  ) {
    const isScheduled = delayMs > 1000;

    const priorityMap: Record<string, number> = {
      high: 1,
      normal: 5,
      low: 10,
    };

    const basePriority = priorityMap[priority] ?? priorityMap.normal;

    return {
      priority: isScheduled ? basePriority + 10 : basePriority,
      delay: delayMs > 0 ? delayMs : 0,
      jobId: messageJobId(messageId),
    };
  }
}
