import { Injectable } from '@nestjs/common';

@Injectable()
export class BotSentMessageRegistry {
  private readonly ids = new Map<string, number>();
  private readonly TTL_MS = 2 * 60 * 1000;

  register(messageId: string): void {
    this.ids.set(messageId, Date.now());
    this.cleanup();
  }

  consume(messageId: string): boolean {
    const existed = this.ids.has(messageId);
    if (existed) this.ids.delete(messageId);
    return existed;
  }

  private cleanup(): void {
    const cutoff = Date.now() - this.TTL_MS;
    for (const [id, ts] of this.ids.entries()) {
      if (ts < cutoff) this.ids.delete(id);
    }
  }
}
