import { Injectable, Logger } from '@nestjs/common';

interface PendingChat {
  messages: string[];
  hasImage: boolean;
  first: number;
  timer: NodeJS.Timeout;
}

@Injectable()
export class MessageDebouncer {
  private readonly logger = new Logger(MessageDebouncer.name);

  private readonly pending = new Map<string, PendingChat>();

  private readonly processedIds = new Set<string>();

  private readonly PROCESSED_ID_TTL_MS = 60_000;

  debounce(
    jid: string,
    text: string | null,
    hasImage: boolean,
    delayMs: number,
    onReady: (texts: string[], hasImage: boolean) => Promise<void>,
    messageId?: string,
  ): void {
    if (messageId) {
      if (this.processedIds.has(messageId)) {
        this.logger.debug(`Mensaje duplicado ignorado: ${messageId}`);
        return;
      }
      this.processedIds.add(messageId);
      setTimeout(
        () => this.processedIds.delete(messageId),
        this.PROCESSED_ID_TTL_MS,
      );
    }

    const key = this.normalizeJid(jid);

    const existing = this.pending.get(key);

    if (existing) {
      clearTimeout(existing.timer);

      if (text) existing.messages.push(text);
      if (hasImage) existing.hasImage = true;

      this.logger.debug(
        `Acumulado para ${jid}: ${existing.messages.length} msg(s), hasImage=${existing.hasImage}`,
      );

      existing.timer = setTimeout(async () => {
        this.pending.delete(key);
        this.logger.debug(
          `Debounce completado para ${jid}. Procesando ${existing.messages.length} mensaje(s).`,
        );

        try {
          await onReady(existing.messages, existing.hasImage);
        } catch (err) {
          this.logger.error(
            `Error en debounce callback para ${key}: ${err.message}`,
          );
        }
      }, Number(delayMs));
    } else {
      const entry: PendingChat = {
        messages: text ? [text] : [],
        hasImage,
        first: Date.now(),
        timer: null as any,
      };

      entry.timer = setTimeout(async () => {
        this.pending.delete(key);

        this.logger.debug(
          `Debounce completado para ${jid}. Procesando ${entry.messages.length} mensaje(s).`,
        );

        try {
          await onReady(entry.messages, entry.hasImage);
        } catch (err) {
          this.logger.error(
            `Error en debounce callback para ${key}: ${err.message}`,
          );
        }
      }, Number(delayMs));

      this.pending.set(key, entry);
    }
  }

  hasPending(jid: string): boolean {
    return this.pending.has(jid);
  }

  cancel(jid: string): void {
    const entry = this.pending.get(this.normalizeJid(jid));

    if (entry) {
      clearTimeout(entry.timer);
      this.pending.delete(this.normalizeJid(jid));
      this.logger.debug(`Debounce cancelado para ${jid}`);
    }
  }

  private normalizeJid(jid: string): string {
    return jid
      .replace(/@s\.whatsapp\.net$/, '')
      .replace(/@lid$/, '')
      .replace(/@c\.us$/, '')
      .replace(/:\d+$/, '')
      .trim();
  }
}
