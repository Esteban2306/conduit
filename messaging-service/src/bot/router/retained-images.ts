export const RETAINED_IMAGE_MS = 30 * 60_000;

export class RetainedImages<T> {
  private readonly entries = new Map<
    string,
    { message: T; receivedAt: number }
  >();

  constructor(
    private readonly ttlMs: number = RETAINED_IMAGE_MS,
    private readonly now: () => number = Date.now,
  ) {}

  keep(conversationId: string, message: T): void {
    this.entries.set(conversationId, { message, receivedAt: this.now() });
  }

  get(conversationId: string): T | undefined {
    const entry = this.entries.get(conversationId);
    if (!entry) return undefined;
    if (this.now() - entry.receivedAt > this.ttlMs) {
      this.entries.delete(conversationId);
      return undefined;
    }
    return entry.message;
  }

  consume(conversationId: string): void {
    this.entries.delete(conversationId);
  }
}
