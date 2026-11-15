import { Injectable } from '@nestjs/common';
import { OutboundReply, OutboundReplyStatus, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from 'src/shared/prisma.service';
import { EXPIRED_REPLY } from 'src/bot/conversation/ConversationService';
import { OUTBOX_TTL_MS, STALE_SENDING_MS } from './outbox-policy';

export interface EnqueueReply {
  tenantId: string;
  connectionId: string;
  conversationId?: string | null;
  phoneNumber: string;
  bubbles: string[];
  tokensUsed?: number;
  imageVerified?: boolean;
  /** Último mensaje del cliente que esta respuesta contesta. */
  answeredUntil?: Date | null;
  /** false si ya hubo una acción con efectos en el turno: no se descarta. */
  supersedable?: boolean;
}

const LIVE: OutboundReplyStatus[] = [
  OutboundReplyStatus.PENDING,
  OutboundReplyStatus.SENDING,
];

@Injectable()
export class OutboundReplyService {
  constructor(private readonly prisma: PrismaService) {}

  async enqueue(input: EnqueueReply): Promise<string> {
    const groupId = randomUUID();
    const now = Date.now();
    const expiresAt = new Date(now + OUTBOX_TTL_MS);
    const createdAt = (seq: number) => new Date(now + seq);
    await this.prisma.outboundReply.createMany({
      data: input.bubbles.map((content, seq) => ({
        tenantId: input.tenantId,
        connectionId: input.connectionId,
        conversationId: input.conversationId ?? null,
        phoneNumber: input.phoneNumber,
        groupId,
        seq,
        bubbleCount: input.bubbles.length,
        content,
        tokensUsed: input.tokensUsed ?? 0,
        imageVerified: input.imageVerified ?? null,
        answeredUntil: input.answeredUntil ?? null,
        supersedable: input.supersedable ?? true,
        idempotencyKey: `${groupId}:${seq}`,
        nextAttemptAt: new Date(now),
        expiresAt,
        createdAt: createdAt(seq),
      })),
    });
    return groupId;
  }

  async dueConnections(now: Date): Promise<string[]> {
    const rows = await this.prisma.outboundReply.findMany({
      where: {
        status: OutboundReplyStatus.PENDING,
        nextAttemptAt: { lte: now },
        expiresAt: { gt: now },
      },
      distinct: ['connectionId'],
      select: { connectionId: true },
    });
    return rows.map((r) => r.connectionId);
  }

  nextDue(
    connectionId: string,
    now: Date,
    limit = 50,
  ): Promise<OutboundReply[]> {
    return this.prisma.outboundReply.findMany({
      where: {
        connectionId,
        status: { in: LIVE },
        expiresAt: { gt: now },
      },
      orderBy: [{ createdAt: 'asc' }, { seq: 'asc' }],
      take: limit,
    });
  }

  async claim(id: string): Promise<boolean> {
    const claimed = await this.prisma.outboundReply.updateMany({
      where: { id, status: OutboundReplyStatus.PENDING },
      data: { status: OutboundReplyStatus.SENDING },
    });
    return claimed.count === 1;
  }

  async setWaMessageId(id: string, waMessageId: string): Promise<void> {
    await this.prisma.outboundReply.update({
      where: { id },
      data: { waMessageId },
    });
  }

  async markSent(id: string): Promise<void> {
    await this.prisma.outboundReply.update({
      where: { id },
      data: {
        status: OutboundReplyStatus.SENT,
        sentAt: new Date(),
        lastError: null,
      },
    });
  }

  async release(
    id: string,
    options: { delayMs: number; countAttempt: boolean; error?: string },
  ): Promise<void> {
    // Sin pisar un descarte: si el cliente escribió mientras tanto, la
    // respuesta ya quedó SUPERSEDED y no debe volver a la cola.
    await this.prisma.outboundReply.updateMany({
      where: { id, status: { not: OutboundReplyStatus.SUPERSEDED } },
      data: {
        status: OutboundReplyStatus.PENDING,
        nextAttemptAt: new Date(Date.now() + options.delayMs),
        lastError: options.error ?? null,
        ...(options.countAttempt && { attempts: { increment: 1 } }),
      },
    });
  }

  /** Una burbuja que falla para siempre arrastra a las siguientes del mismo mensaje: no salen sueltas. */
  async failRestOfGroup(groupId: string, afterSeq: number): Promise<void> {
    await this.prisma.outboundReply.updateMany({
      where: {
        groupId,
        seq: { gt: afterSeq },
        status: { in: LIVE },
      },
      data: {
        status: OutboundReplyStatus.FAILED,
        lastError: 'Una burbuja anterior no pudo enviarse',
      },
    });
  }

  statusOf(id: string): Promise<OutboundReplyStatus | null> {
    return this.prisma.outboundReply
      .findUnique({ where: { id }, select: { status: true } })
      .then((row) => row?.status ?? null);
  }

  /** Descarta lo que aún no salió de una respuesta; nada de ella llegó al cliente. */
  async supersedeGroup(groupId: string): Promise<number> {
    const result = await this.prisma.outboundReply.updateMany({
      where: { groupId, status: { in: LIVE } },
      data: {
        status: OutboundReplyStatus.SUPERSEDED,
        lastError: 'El cliente escribió de nuevo: respuesta desactualizada',
      },
    });
    return result.count;
  }

  /**
   * El cliente escribió de nuevo: las respuestas de esa conversación que aún
   * no salieron quedan desactualizadas y se descartan. Se respetan dos
   * límites: una respuesta con una primera burbuja ya enviada sale completa
   * (cortarla a la mitad deja un mensaje sin sentido) y una cuyo turno ya hizo
   * una acción con efectos debe llegar al cliente.
   */
  async supersedeUnsent(conversationId: string): Promise<number> {
    const live = await this.prisma.outboundReply.findMany({
      where: { conversationId, status: { in: LIVE } },
      select: { id: true, groupId: true, supersedable: true },
    });
    if (live.length === 0) return 0;

    const groupIds = [...new Set(live.map((r) => r.groupId))];
    const sentGroups = await this.prisma.outboundReply.findMany({
      where: { groupId: { in: groupIds }, status: OutboundReplyStatus.SENT },
      select: { groupId: true },
      distinct: ['groupId'],
    });
    const committed = new Set(sentGroups.map((r) => r.groupId));
    for (const row of live) if (!row.supersedable) committed.add(row.groupId);

    const ids = live.filter((r) => !committed.has(r.groupId)).map((r) => r.id);
    if (ids.length === 0) return 0;

    const result = await this.prisma.outboundReply.updateMany({
      where: { id: { in: ids }, status: { in: LIVE } },
      data: {
        status: OutboundReplyStatus.SUPERSEDED,
        lastError: 'El cliente escribió de nuevo: respuesta desactualizada',
      },
    });
    return result.count;
  }

  async tenantOf(connectionId: string): Promise<string | null> {
    const connection = await this.prisma.whatsAppConnection.findUnique({
      where: { id: connectionId },
      select: { tenantId: true },
    });
    return connection?.tenantId ?? null;
  }

  async markFailed(id: string, error: string): Promise<void> {
    await this.prisma.outboundReply.update({
      where: { id },
      data: {
        status: OutboundReplyStatus.FAILED,
        lastError: error,
        attempts: { increment: 1 },
      },
    });
  }

  async expireDue(now: Date): Promise<OutboundReply[]> {
    const due = await this.prisma.outboundReply.findMany({
      where: {
        status: OutboundReplyStatus.PENDING,
        expiresAt: { lte: now },
      },
    });
    if (due.length === 0) return [];
    await this.prisma.outboundReply.updateMany({
      where: {
        id: { in: due.map((r) => r.id) },
        status: OutboundReplyStatus.PENDING,
      },
      data: {
        status: OutboundReplyStatus.EXPIRED,
        lastError: 'Caducó sin poder enviarse',
      },
    });
    return due;
  }

  async resetStale(now: Date): Promise<number> {
    const reset = await this.prisma.outboundReply.updateMany({
      where: {
        status: OutboundReplyStatus.SENDING,
        updatedAt: { lt: new Date(now.getTime() - STALE_SENDING_MS) },
      },
      data: { status: OutboundReplyStatus.PENDING },
    });
    return reset.count;
  }

  groupRows(groupId: string): Promise<OutboundReply[]> {
    return this.prisma.outboundReply.findMany({
      where: { groupId },
      orderBy: { seq: 'asc' },
    });
  }

  /** Cuándo salió cada respuesta reciente de una conexión: reconstruye el limitador tras un reinicio. */
  async sentSince(connectionId: string, since: Date): Promise<Date[]> {
    const rows = await this.prisma.outboundReply.findMany({
      where: {
        connectionId,
        status: OutboundReplyStatus.SENT,
        sentAt: { gte: since },
      },
      select: { sentAt: true },
    });
    return rows.flatMap((r) => (r.sentAt ? [r.sentAt] : []));
  }

  /**
   * Los mensajes del cliente cuya respuesta caducó quedan marcados para que
   * la recuperación al reconectar no los conteste solos meses después.
   */
  async markInboundUnanswered(
    conversationId: string,
    upTo: Date,
  ): Promise<number> {
    const where: Prisma.BotMessageWhereInput = {
      conversationId,
      direction: 'INBOUND',
      processedBy: 'user',
      createdAt: { lte: upTo },
    };
    const marked = await this.prisma.botMessage.updateMany({
      where,
      data: { processedBy: EXPIRED_REPLY },
    });
    return marked.count;
  }
}
