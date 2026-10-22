import { Injectable } from '@nestjs/common';

@Injectable()
export class messageReceiptTracker {
  private readonly activeChats = new Map<string, number>();
  private readonly typingChats = new Map<string, number>();
  private readonly TTL_MS = 5 * 60 * 1000;
  private readonly TYPING_WINDOW_MS = 30_000;

  markChatActive(key: string): void {
    this.activeChats.set(key, Date.now());
    this.cleanup();
  }

  markTyping(key: string): void {
    this.typingChats.set(key, Date.now());
  }

  clearTyping(key: string): void {
    this.typingChats.delete(key);
  }

  isTyping(key: string): boolean {
    const lastTyping = this.typingChats.get(key);
    return !!lastTyping && Date.now() - lastTyping < this.TYPING_WINDOW_MS;
  }

  isChatActive(key: string, withinMs = 30000): boolean {
    return this.msSinceActive(key) < withinMs;
  }

  msSinceActive(key: string): number {
    const lastActive = this.activeChats.get(key);
    return lastActive ? Date.now() - lastActive : Number.POSITIVE_INFINITY;
  }

  private cleanup(): void {
    const cutoff = Date.now() - this.TTL_MS;
    for (const [key, ts] of this.activeChats) {
      if (ts < cutoff) this.activeChats.delete(key);
    }
    for (const [key, ts] of this.typingChats) {
      if (ts < cutoff) this.typingChats.delete(key);
    }
  }
}
