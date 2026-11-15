import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { generateMessageIDV2 } from '@whiskeysockets/baileys';
import { OutboundReply, OutboundReplyStatus } from '@prisma/client';
import { ConversationService } from 'src/bot/conversation/ConversationService';
import { EVENT_TYPES } from 'src/infra/events/constants/event.types';
import { EventBusService } from 'src/infra/events/event.service';
import type { SendGate } from 'src/channels/types/IChannelPlugin';
import { OpsAlertService } from '../alerts/OpsAlert.service';
import { BaileysPlugin } from '../baileys/BaileysPlugin';
import { BaileysSessionManager } from '../baileys/BaileysSessionManager';
import { messageReceiptTracker } from '../baileys/MessageReceiptTracker';
import { isLidAddress, phoneToJid } from '../utils/jid.util';
import { chatKey } from '../utils/chat-key';
import { OutboundReplyService } from './OutboundReply.service';
import { TYPING_HOLD_MAX_MS, verdictFor } from './outbox-policy';

const TICK_MS = 2_000;
const CYCLE_ERROR_REPEAT_MS = 5 * 60_000;

type RowResult = 'ok' | 'blocked' | 'stop';

/**
 * Entrega las respuestas de la bandeja de salida en orden por conversación.
 * Solo trabaja con las conexiones que esta instancia tiene abiertas (el lease
 * de sesión garantiza que es una sola) y envía a través del limitador, así
 * que al reconectar el vaciado respeta el ritmo de siempre.
 */
@Injectable()
export class OutboundReplyDispatcher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboundReplyDispatcher.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private again = false;
  private lastCycleError = '';
  private lastCycleErrorAt = 0;
  /** Desde cuándo se espera a que un cliente deje de escribir, por respuesta. */
  private readonly typingHolds = new Map<string, number>();

  constructor(
    private readonly outbox: OutboundReplyService,
    private readonly plugin: BaileysPlugin,
    private readonly session: BaileysSessionManager,
    private readonly conversations: ConversationService,
    private readonly eventBus: EventBusService,
    private readonly alerts: OpsAlertService,
    private readonly receiptTracker: messageReceiptTracker,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => this.kick(), TICK_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  kick(): void {
    void this.tick();
  }

  async tick(): Promise<void> {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.again = false;
        await this.cycle();
      } while (this.again);
    } catch (error) {
      this.reportCycleFailure(error);
    } finally {
      this.running = false;
    }
  }

  private reportCycleFailure(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const signature = message.split('\n').slice(-1)[0].slice(0, 160);
    const now = Date.now();
    if (
      signature === this.lastCycleError &&
      now - this.lastCycleErrorAt < CYCLE_ERROR_REPEAT_MS
    ) {
      return;
    }
    this.lastCycleError = signature;
    this.lastCycleErrorAt = now;
    this.logger.error(`Ciclo de la bandeja de salida: ${message}`);
  }

  private async cycle(): Promise<void> {
    const now = new Date();
    await this.outbox.resetStale(now);

    const expired = await this.outbox.expireDue(now);
    for (const groupId of new Set(expired.map((r) => r.groupId))) {
      await this.finalizeGroup(groupId);
    }

    const connections = await this.outbox.dueConnections(now);
    await Promise.all(
      connections
        .filter((id) => this.session.isConnected(id))
        .map((id) => this.drain(id)),
    );
  }

  private async drain(connectionId: string): Promise<void> {
    const blocked = new Set<string>();
    const rows = await this.outbox.nextDue(connectionId, new Date());
    for (const row of rows) {
      const key = row.conversationId ?? row.phoneNumber;
      if (blocked.has(key)) continue;
      if (
        row.status === OutboundReplyStatus.SENDING ||
        row.nextAttemptAt.getTime() > Date.now()
      ) {
        blocked.add(key);
        continue;
      }
      if (!this.session.isConnected(connectionId)) return;
      const result = await this.deliver(row);
      if (result === 'stop') return;
      if (result === 'blocked') blocked.add(key);
    }
  }

  private async deliver(row: OutboundReply): Promise<RowResult> {
    if (!(await this.outbox.claim(row.id))) return 'blocked';

    let waMessageId = row.waMessageId;
    if (!waMessageId) {
      waMessageId = generateMessageIDV2(
        this.session.get(row.connectionId)?.user?.id,
      );
      await this.outbox.setWaMessageId(row.id, waMessageId);
    }

    let result: Awaited<ReturnType<BaileysPlugin['send']>>;
    try {
      result = await this.plugin.send({
        to: row.phoneNumber,
        content: row.content,
        subject: '',
        connectionId: row.connectionId,
        priority: 'conversation',
        messageId: waMessageId,
        gate: this.gateFor(row),
      });
    } catch (error) {
      result = {
        success: false,
        provider: this.plugin.providerName,
        retryable: true,
        errorCode: 'SEND_FAILED',
        error: error instanceof Error ? error.message : String(error),
        raw: null,
      };
    }

    const verdict = verdictFor(result, row.attempts + 1);
    switch (verdict.action) {
      case 'sent':
        this.typingHolds.delete(row.groupId);
        await this.outbox.markSent(row.id);
        await this.finalizeGroup(row.groupId);
        return 'ok';
      case 'cancel':
        // El cliente escribió de nuevo: nada de esta respuesta llegó a él y sus
        // mensajes siguen pendientes, así que la siguiente pasada del bot los
        // responde todos juntos con lo más reciente.
        this.typingHolds.delete(row.groupId);
        await this.outbox.supersedeGroup(row.groupId);
        this.logger.log(
          `Respuesta a ${row.phoneNumber} descartada: el cliente escribió de nuevo antes de que saliera.`,
        );
        return 'blocked';
      case 'hold':
        await this.outbox.release(row.id, {
          delayMs: verdict.delayMs,
          countAttempt: false,
        });
        return 'blocked';
      case 'wait':
        await this.outbox.release(row.id, {
          delayMs: verdict.delayMs,
          countAttempt: false,
          error: result.error,
        });
        return 'stop';
      case 'retry':
        await this.outbox.release(row.id, {
          delayMs: verdict.delayMs,
          countAttempt: true,
          error: result.error,
        });
        return 'blocked';
      case 'fail':
        this.typingHolds.delete(row.groupId);
        await this.outbox.markFailed(
          row.id,
          result.error ?? 'Error desconocido',
        );
        await this.outbox.failRestOfGroup(row.groupId, row.seq);
        this.logger.error(
          `Respuesta a ${row.phoneNumber} no entregada: ${result.error}`,
        );
        await this.finalizeGroup(row.groupId);
        return 'blocked';
    }
  }

  /**
   * Revisión previa al envío de la primera burbuja: la respuesta se descarta
   * si el cliente escribió después de lo que ella contesta, y espera (con
   * tope) si en este momento está escribiendo. Las burbujas siguientes ya no
   * se cuestionan: cortar un mensaje a la mitad dejaría un chat sin sentido.
   */
  private gateFor(row: OutboundReply): (() => Promise<SendGate>) | undefined {
    if (row.seq > 0 || !row.conversationId) return undefined;
    const conversationId = row.conversationId;
    return async () => {
      if (
        (await this.outbox.statusOf(row.id)) === OutboundReplyStatus.SUPERSEDED
      ) {
        return 'cancel';
      }
      if (
        row.supersedable &&
        (await this.conversations.hasNewInboundSince(
          conversationId,
          row.answeredUntil,
        ))
      ) {
        return 'cancel';
      }
      return this.clientIsTyping(row) ? 'hold' : 'send';
    };
  }

  private clientIsTyping(row: OutboundReply): boolean {
    const jid = isLidAddress(row.phoneNumber)
      ? row.phoneNumber
      : phoneToJid(row.phoneNumber);
    if (!this.receiptTracker.isTyping(chatKey(row.connectionId, jid))) {
      this.typingHolds.delete(row.groupId);
      return false;
    }
    const since = this.typingHolds.get(row.groupId) ?? Date.now();
    this.typingHolds.set(row.groupId, since);
    return Date.now() - since < TYPING_HOLD_MAX_MS;
  }

  /**
   * Cuando todas las burbujas de una respuesta terminaron, se guarda en el
   * historial lo que realmente salió. Si algo no salió se avisa al equipo y,
   * si no salió nada, los mensajes del cliente quedan marcados para que la
   * recuperación no los conteste sola mucho después.
   */
  private async finalizeGroup(groupId: string): Promise<void> {
    const rows = await this.outbox.groupRows(groupId);
    if (rows.length === 0) return;
    const live = rows.some(
      (r) =>
        r.status === OutboundReplyStatus.PENDING ||
        r.status === OutboundReplyStatus.SENDING,
    );
    if (live) return;

    const first = rows[0];
    const sent = rows.filter((r) => r.status === OutboundReplyStatus.SENT);

    // Una respuesta descartada por quedar desactualizada no es un fallo de
    // entrega: sus mensajes siguen pendientes y no se avisa ni se marcan.
    if (
      sent.length === 0 &&
      rows.some((r) => r.status === OutboundReplyStatus.SUPERSEDED)
    ) {
      return;
    }

    if (sent.length > 0 && first.conversationId) {
      await this.conversations
        .saveOutbound(
          first.conversationId,
          sent.map((r) => r.content).join('\n\n'),
          {
            tokensUsed: first.tokensUsed,
            imageVerified: first.imageVerified ?? undefined,
            connectionId: first.connectionId,
            answeredUntil: first.answeredUntil,
          },
        )
        .catch((error: unknown) => {
          this.logger.error(
            `No fue posible guardar la respuesta enviada a ${first.phoneNumber}: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      this.eventBus.publish(EVENT_TYPES.CHANNEL_SEND_COMPLETED, {
        phoneNumber: first.phoneNumber,
        providerMessageId: sent[sent.length - 1].waMessageId ?? undefined,
      });
    }

    if (sent.length === rows.length) return;

    if (sent.length === 0 && first.conversationId) {
      await this.outbox
        .markInboundUnanswered(first.conversationId, first.createdAt)
        .catch(() => 0);
    }
    const tenantId =
      first.tenantId || (await this.outbox.tenantOf(first.connectionId));
    if (tenantId) {
      this.alerts.report(
        tenantId,
        'undelivered',
        `${first.phoneNumber}: ${sent.length === 0 ? 'respuesta sin enviar' : `respuesta incompleta (${sent.length} de ${rows.length} burbujas)`}`,
      );
    }
  }
}
