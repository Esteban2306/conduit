export const PREFETCH_TTL_MS = 30 * 60_000;

export type PrefetchTake<T> =
  | { status: 'READY'; value: T; waitedMs: number }
  | { status: 'TIMEOUT'; waitedMs: number }
  | { status: 'FAILED'; waitedMs: number }
  | { status: 'MISSING'; waitedMs: number };

type EntryState = 'WAITING' | 'RUNNING' | 'DONE' | 'FAILED' | 'SUPERSEDED';

interface Entry<T> {
  messageId: string;
  run: () => Promise<T>;
  state: EntryState;
  settled: boolean;
  timer?: NodeJS.Timeout;
  finished?: Promise<void>;
  value?: T;
  createdAt: number;
}

interface ConversationState<T> {
  entries: Map<string, Entry<T>>;
  running: Entry<T> | null;
  waiting: Entry<T> | null;
}

export interface ImagePrefetchOptions {
  settleMs: number;
  ttlMs?: number;
  now?: () => number;
}

export class ImagePrefetch<T> {
  private readonly conversations = new Map<string, ConversationState<T>>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(private readonly options: ImagePrefetchOptions) {
    this.ttlMs = options.ttlMs ?? PREFETCH_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  schedule(
    conversationId: string,
    messageId: string,
    run: () => Promise<T>,
  ): void {
    this.prune();
    const state = this.stateOf(conversationId);
    if (state.entries.has(messageId)) return;

    if (state.waiting) this.supersede(state.waiting);

    const entry: Entry<T> = {
      messageId,
      run,
      state: 'WAITING',
      settled: false,
      createdAt: this.now(),
    };
    state.entries.set(messageId, entry);
    state.waiting = entry;

    const settle = (): void => {
      entry.settled = true;
      if (entry.state === 'WAITING' && !state.running) this.start(state, entry);
    };
    if (this.options.settleMs <= 0) {
      settle();
      return;
    }
    entry.timer = setTimeout(settle, this.options.settleMs);
    entry.timer.unref?.();
  }

  async take(
    conversationId: string,
    messageId: string,
    waitMs: number,
  ): Promise<PrefetchTake<T>> {
    const startedAt = this.now();
    const waited = () => this.now() - startedAt;
    const state = this.conversations.get(conversationId);
    const entry = state?.entries.get(messageId);
    if (!state || !entry || entry.state === 'SUPERSEDED') {
      return { status: 'MISSING', waitedMs: waited() };
    }

    if (entry.state === 'WAITING') this.start(state, entry);

    if (entry.state === 'RUNNING' && entry.finished) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        entry.finished,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, Math.max(0, waitMs));
          timer.unref?.();
        }),
      ]);
      if (timer) clearTimeout(timer);
    }

    if (entry.state === 'DONE') {
      return { status: 'READY', value: entry.value as T, waitedMs: waited() };
    }
    if (entry.state === 'FAILED') {
      return { status: 'FAILED', waitedMs: waited() };
    }
    return { status: 'TIMEOUT', waitedMs: waited() };
  }

  discard(conversationId: string): void {
    const state = this.conversations.get(conversationId);
    if (!state) return;
    for (const entry of state.entries.values()) {
      if (entry.timer) clearTimeout(entry.timer);
    }
    this.conversations.delete(conversationId);
  }

  size(): number {
    return this.conversations.size;
  }

  private stateOf(conversationId: string): ConversationState<T> {
    let state = this.conversations.get(conversationId);
    if (!state) {
      state = { entries: new Map(), running: null, waiting: null };
      this.conversations.set(conversationId, state);
    }
    return state;
  }

  private supersede(entry: Entry<T>): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.state = 'SUPERSEDED';
  }

  private start(state: ConversationState<T>, entry: Entry<T>): void {
    if (entry.state !== 'WAITING') return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.state = 'RUNNING';
    if (state.waiting === entry) state.waiting = null;
    state.running = entry;

    entry.finished = entry
      .run()
      .then(
        (value) => {
          entry.value = value;
          entry.state = 'DONE';
        },
        () => {
          entry.state = 'FAILED';
        },
      )
      .then(() => {
        if (state.running === entry) state.running = null;
        const next = state.waiting;
        if (next && next.settled && next.state === 'WAITING') {
          this.start(state, next);
        }
      });
  }

  private prune(): void {
    const limit = this.now() - this.ttlMs;
    for (const [conversationId, state] of this.conversations) {
      for (const [messageId, entry] of state.entries) {
        const idle = entry.state !== 'RUNNING' && entry.state !== 'WAITING';
        if (idle && entry.createdAt < limit) state.entries.delete(messageId);
      }
      if (state.entries.size === 0 && !state.running && !state.waiting) {
        this.conversations.delete(conversationId);
      }
    }
  }
}
