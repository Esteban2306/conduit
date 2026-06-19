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

  debounce(
    jid: string,
    text: string | null,
    hasImage: boolean,
    delayMs: number,
    onReady: (texts: string[], hasImage: boolean) => Promise<void>,
  ): void {
    const existing = this.pending.get(jid);

    if (existing) {
      clearTimeout(existing.timer);

      if (text) existing.messages.push(text);
      if (hasImage) existing.hasImage = true;

      this.logger.debug(
        `Mensaje acumulado para ${jid}. Total: ${existing.messages.length}`,
      );
    } else {
      const entry: Omit<PendingChat, 'timer'> = {
        messages: text ? [text] : [],
        hasImage,
        first: Date.now(),
      };

      const normalized = this.normalizeJid(jid);

      this.pending.set(normalized, { ...entry, timer: null as any });
    }

    const current = this.pending.get(this.normalizeJid(jid));

    if (current) {
      current.timer = setTimeout(async () => {
        this.pending.delete(jid);

        const { messages, hasImage: chatHasImage } = current;

        this.logger.debug(
          `Debounce completado para ${jid}. Procesando ${messages.length} mensaje(s).`,
        );

        try {
          await onReady(messages, chatHasImage);
        } catch (err) {
          this.logger.error(
            `Error en debounce callback para ${jid}: ${err.message}`,
          );
        }
      }, Number(delayMs));
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
