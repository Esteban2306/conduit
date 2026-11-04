import { Injectable, Logger } from '@nestjs/common';

interface ScheduledTurn {
  timer: NodeJS.Timeout;
  onReady: () => Promise<void>;
}

@Injectable()
export class MessageDebouncer {
  private readonly logger = new Logger(MessageDebouncer.name);
  private readonly pending = new Map<string, ScheduledTurn>();

  schedule(key: string, delayMs: number, onReady: () => Promise<void>): void {
    const existing = this.pending.get(key);
    if (existing) clearTimeout(existing.timer);

    const entry: ScheduledTurn = {
      onReady,
      timer: setTimeout(() => {
        if (this.pending.get(key) !== entry) return;
        this.pending.delete(key);
        entry.onReady().catch((err: unknown) => {
          this.logger.error(
            `Error respondiendo ${key}: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      }, delayMs),
    };
    this.pending.set(key, entry);
  }

  hasPending(key: string): boolean {
    return this.pending.has(key);
  }

  cancel(key: string): void {
    const entry = this.pending.get(key);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(key);
    this.logger.debug(`Respuesta programada cancelada para ${key}`);
  }
}
