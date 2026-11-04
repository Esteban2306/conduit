import { randomUUID } from 'crypto';
import { recorder } from './recorder';
import {
  BaileysRateLimiter,
  JobPriority,
  WarmupLevel,
} from 'src/channels/whatsapp/baileys/BaileysRateLimiter';

interface SendPayload {
  to: string;
  content: string;
  subject?: string;
  connectionId?: string;
}

export interface Pacing {
  level: WarmupLevel;
  timeZone: string;
}

const randomInt = (min: number, max: number) =>
  Math.floor(min + Math.random() * (max - min + 1));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class FakeChannelPlugin {
  private readonly limiters = new Map<string, BaileysRateLimiter>();

  constructor(
    readonly channel: string,
    readonly providerName: string,
    private readonly pacing?: Pacing,
  ) {}

  send(payload: SendPayload & { priority?: string }) {
    const ctx = recorder.ctx();
    const queuedAt = Date.now();
    if (!this.pacing || this.channel !== 'WHATSAPP') {
      return Promise.resolve(this.deliver(payload, ctx, queuedAt));
    }
    const connectionId = payload.connectionId ?? 'default';
    let limiter = this.limiters.get(connectionId);
    if (!limiter) {
      limiter = new BaileysRateLimiter(
        connectionId,
        this.pacing.level,
        this.pacing.timeZone,
      );
      this.limiters.set(connectionId, limiter);
    }
    const isConversation = payload.priority === 'conversation';
    return limiter.enqueue(
      async () => {
        const typingMs =
          Math.min(payload.content.length * 40, 4000) + randomInt(500, 1500);
        await wait(typingMs);
        return this.deliver(payload, ctx, queuedAt);
      },
      {
        priority: isConversation
          ? JobPriority.CONVERSATION
          : JobPriority.CAMPAIGN,
      },
    );
  }

  queueDepth(): { conversation: number; campaign: number } {
    return [...this.limiters.values()].reduce(
      (acc, l) => {
        const sizes = l.getLaneSizes();
        return {
          conversation: acc.conversation + sizes.conversation,
          campaign: acc.campaign + sizes.campaign,
        };
      },
      { conversation: 0, campaign: 0 },
    );
  }

  private deliver(
    payload: SendPayload,
    ctx: ReturnType<typeof recorder.ctx>,
    queuedAt: number,
  ) {
    const now = Date.now();
    recorder.sent.push({
      ctx,
      channel: this.channel,
      to: payload.to,
      content: payload.content,
      connectionId: payload.connectionId ?? null,
      at: now,
      queuedMs: now - queuedAt,
    });
    const providerMessageId = `bench-${randomUUID()}`;
    return {
      success: true,
      provider: this.providerName,
      providerMessageId,
      raw: { key: { id: providerMessageId } },
    };
  }

  validateRecipient(): boolean {
    return true;
  }
}

const fakeSocket = {
  user: { id: '573000000000:1@s.whatsapp.net' },
  readMessages: () => Promise.resolve(),
  sendPresenceUpdate: () => Promise.resolve(),
  presenceSubscribe: () => Promise.resolve(),
  onWhatsApp: (jid: string) => Promise.resolve([{ exists: true, jid }]),
};

export function fakeSessionManager(): object {
  const explicit: Record<string, unknown> = {
    get: () => fakeSocket,
    isConnected: () => true,
  };
  return new Proxy(explicit, {
    get(target, prop) {
      if (typeof prop === 'symbol' || prop === 'then') return undefined;
      if (prop in target) return target[prop];
      return () => Promise.resolve();
    },
  });
}
