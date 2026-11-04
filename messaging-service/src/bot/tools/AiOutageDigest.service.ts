import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { BotEscalationService } from './BotEscalation.service';

interface AffectedChat {
  address: string;
  detail: string;
  failures: number;
  firstAt: number;
}

interface Batch {
  tenantId: string;
  botConfigId: string;
  chats: Map<string, AffectedChat>;
  attempts: number;
  timer?: NodeJS.Timeout;
}

export const OUTAGE_DIGEST_WINDOW_MS = 60_000;
export const OUTAGE_DIGEST_RETRY_MS = 5 * 60_000;
export const OUTAGE_DIGEST_MAX_ATTEMPTS = 3;
export const OUTAGE_DIGEST_MAX_LISTED = 15;

/**
 * Agrupa los fallos de IA por bot: el primero abre una ventana corta y todo lo
 * que falle dentro de ella sale en UN solo mensaje al equipo, con la lista de
 * chats afectados. Si nadie pudo ser notificado, el lote se conserva y se
 * reintenta; no se pierde en silencio.
 */
@Injectable()
export class AiOutageDigestService implements OnModuleDestroy {
  private readonly logger = new Logger(AiOutageDigestService.name);
  private readonly batches = new Map<string, Batch>();

  constructor(private readonly escalation: BotEscalationService) {}

  report(
    tenantId: string,
    botConfigId: string,
    chatAddress: string,
    detail: string,
  ): void {
    let batch = this.batches.get(botConfigId);
    if (!batch) {
      batch = { tenantId, botConfigId, chats: new Map(), attempts: 0 };
      this.batches.set(botConfigId, batch);
    }

    const known = batch.chats.get(chatAddress);
    if (known) {
      known.failures += 1;
      known.detail = detail;
    } else {
      batch.chats.set(chatAddress, {
        address: chatAddress,
        detail,
        failures: 1,
        firstAt: Date.now(),
      });
    }

    if (!batch.timer) this.schedule(batch, OUTAGE_DIGEST_WINDOW_MS);
  }

  async onModuleDestroy(): Promise<void> {
    await this.flushAll();
  }

  async flushAll(): Promise<void> {
    const pending = [...this.batches.values()];
    for (const batch of pending) {
      if (batch.timer) clearTimeout(batch.timer);
      batch.timer = undefined;
    }
    await Promise.all(pending.map((batch) => this.flush(batch, false)));
  }

  private schedule(batch: Batch, delayMs: number): void {
    batch.timer = setTimeout(() => {
      batch.timer = undefined;
      void this.flush(batch, true);
    }, delayMs);
    batch.timer.unref?.();
  }

  private async flush(batch: Batch, mayRetry: boolean): Promise<void> {
    if (batch.chats.size === 0) {
      this.batches.delete(batch.botConfigId);
      return;
    }

    const snapshot = [...batch.chats.values()];
    let delivered = false;
    try {
      delivered = await this.escalation.notifyContacts(
        batch.tenantId,
        batch.botConfigId,
        'TECHNICAL_ERROR',
        AiOutageDigestService.compose(snapshot),
        'asistente de IA',
      );
    } catch (error) {
      this.logger.error(
        `No fue posible enviar el aviso de falla de IA: ${(error as Error).message}`,
      );
    }

    if (delivered) {
      for (const chat of snapshot) {
        const current = batch.chats.get(chat.address);
        if (current && current.failures === chat.failures) {
          batch.chats.delete(chat.address);
        } else if (current) {
          current.failures -= chat.failures;
        }
      }
      batch.attempts = 0;
      if (batch.chats.size > 0) this.schedule(batch, OUTAGE_DIGEST_WINDOW_MS);
      else this.batches.delete(batch.botConfigId);
      return;
    }

    batch.attempts += 1;
    if (mayRetry && batch.attempts < OUTAGE_DIGEST_MAX_ATTEMPTS) {
      this.schedule(batch, OUTAGE_DIGEST_RETRY_MS);
      return;
    }
    this.logger.error(
      `Se descarta el aviso de falla de IA del bot ${batch.botConfigId} tras ${batch.attempts} intentos: ${snapshot.length} chat(s) afectado(s) NO fueron notificados al equipo.`,
    );
    this.batches.delete(batch.botConfigId);
  }

  static compose(chats: AffectedChat[]): string {
    const detail = chats[chats.length - 1].detail || 'sin detalle';
    if (chats.length === 1) {
      return (
        `⚠️ Fallo técnico en el bot\n\n` +
        `Herramienta: asistente de IA\n` +
        `Cliente afectado: ${chats[0].address}\n` +
        `Detalle: ${detail}\n\n` +
        `El bot ya avisó al cliente que hubo un problema y que será contactado por una persona.`
      );
    }

    const listed = chats
      .slice(0, OUTAGE_DIGEST_MAX_LISTED)
      .map(
        (chat) =>
          `• ${chat.address}${chat.failures > 1 ? ` (${chat.failures} mensajes)` : ''}`,
      );
    const extra = chats.length - listed.length;
    if (extra > 0) listed.push(`… y ${extra} chat(s) más`);

    return (
      `⚠️ Falla del asistente de IA: ${chats.length} chats afectados\n\n` +
      `${listed.join('\n')}\n\n` +
      `Detalle: ${detail}\n\n` +
      `El bot ya avisó a cada cliente que una persona del equipo los atenderá. Revisa los chats y la IA (saldo, proveedor).`
    );
  }
}
