import { randomUUID } from 'crypto';
import { recorder } from './recorder';

interface SendPayload {
  to: string;
  content: string;
  subject?: string;
  connectionId?: string;
}

export class FakeChannelPlugin {
  constructor(
    readonly channel: string,
    readonly providerName: string,
  ) {}

  send(payload: SendPayload) {
    recorder.sent.push({
      ctx: recorder.ctx(),
      channel: this.channel,
      to: payload.to,
      content: payload.content,
      connectionId: payload.connectionId ?? null,
      at: Date.now(),
    });
    const providerMessageId = `bench-${randomUUID()}`;
    return Promise.resolve({
      success: true,
      provider: this.providerName,
      providerMessageId,
      raw: { key: { id: providerMessageId } },
    });
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
