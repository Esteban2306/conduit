import { Injectable, Logger } from '@nestjs/common';
import { MessageDebouncer } from 'src/bot/router/MessageDebouncer';

interface ReceiptEntry {
  status: number;
  updatedAt: number;
}

@Injectable()
export class messageReceiptTracker {
  constructor(private readonly debouncer: MessageDebouncer) {}
  private readonly logger = new Logger(messageReceiptTracker.name);

  private readonly activeChats = new Map<string, number>();
  private readonly typingChats = new Map<string, number>();
  private readonly TTL_MS = 5 * 60 * 1000;

  markChatActive(remoteJid: string): void {
    const normalized = this.normalizeJid(remoteJid);
    const wasAlreadyActive = this.activeChats.has(normalized);

    this.logger.debug(`Chat activo detectado: ${normalized}`);
    this.activeChats.set(normalized, Date.now());

    this.debouncer.cancel(normalized);

    if (!wasAlreadyActive) {
      this.logger.warn(`Chat marcado activo (bot pausado): ${normalized}`);
    }

    this.cleanup();
  }

  markTyping(remoteJid: string): void {
    const normalized = this.normalizeJid(remoteJid);
    this.typingChats.set(normalized, Date.now());
  }

  clearTyping(remoteJid: string): void {
    const normalized = this.normalizeJid(remoteJid);
    this.typingChats.delete(normalized);
  }

  isTyping(remoteJid: string) {
    const normalized = this.normalizeJid(remoteJid);
    const lastTyping = this.typingChats.get(normalized);
    if (!lastTyping) return false;

    return Date.now() - lastTyping < 30000;
  }

  isChatActive(remoteJid: string, withinMs = 30000): boolean {
    const normalized = this.normalizeJid(remoteJid);
    const lastActive = this.activeChats.get(normalized);
    if (!lastActive) return false;
    return Date.now() - lastActive < withinMs;
  }

  normalizeJid(jid: string): string {
    return jid
      .replace(/@s\.whatsapp\.net$/, '')
      .replace(/@lid$/, '')
      .replace(/@c\.us$/, '')
      .replace(/:\d+$/, '')
      .trim();
  }

  private cleanup(): void {
    const cutoff = Date.now() - this.TTL_MS;
    for (const [jid, ts] of this.activeChats.entries()) {
      if (ts < cutoff) this.activeChats.delete(jid);
    }
  }
}
