jest.mock('@whiskeysockets/baileys', () => ({
  __esModule: true,
  default: jest.fn(),
  DisconnectReason: { loggedOut: 401 },
  generateMessageIDV2: jest.fn(() => `WA-${++idSeq}`),
  proto: {},
}));
let idSeq = 0;

const typing = { fn: (_length: number): number => 0 };
jest.mock('src/channels/whatsapp/baileys/human-timing', () => ({
  ...jest.requireActual('src/channels/whatsapp/baileys/human-timing'),
  typingMs: (length: number) => typing.fn(length),
}));

import { OutboundReplyStatus } from '@prisma/client';
import { BaileysPlugin } from 'src/channels/whatsapp/baileys/BaileysPlugin';
import {
  BaileysRateLimiter,
  WarmupLevel,
} from 'src/channels/whatsapp/baileys/BaileysRateLimiter';
import { OutboundReplyDispatcher } from 'src/channels/whatsapp/outbox/OutboundReplyDispatcher';

/**
 * Perfil de ritmo con el código real de envío (despachador, plugin y
 * limitador) sobre un reloj simulado, un socket falso y sin IA. Mide cuándo
 * salen las respuestas, no si el bot contesta bien.
 *
 * Para ver las tablas: CADENCE_REPORT=1 pnpm jest test/unit/channels/cadence-profile
 */

const START = new Date('2026-11-14T15:00:00Z'); // 10:00 en Bogotá

function seeded(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Variant {
  name: string;
  typingMsPerChar: [number, number];
  typingCapMs: number;
  crossChat: { msPerChar: number; minMs: number; maxMs: number };
}

const CURRENT: Variant = {
  name: 'actual (tipeo 45-70 ms/car, tope 5 s; pausa 6-30 s)',
  typingMsPerChar: [45, 70],
  typingCapMs: 5000,
  crossChat: { msPerChar: 120, minMs: 6000, maxMs: 30000 },
};

interface Row {
  id: string;
  tenantId: string;
  connectionId: string;
  conversationId: string;
  phoneNumber: string;
  groupId: string;
  seq: number;
  bubbleCount: number;
  content: string;
  tokensUsed: number;
  imageVerified: null;
  waMessageId: string | null;
  status: OutboundReplyStatus;
  attempts: number;
  nextAttemptAt: Date;
  expiresAt: Date;
  lastError: null | string;
  createdAt: Date;
  updatedAt: Date;
  answeredUntil: null;
  supersedable: boolean;
}

class Outbox {
  rows: Row[] = [];
  private n = 0;
  add(chat: string, bubbles: string[]) {
    const groupId = `g${++this.n}`;
    bubbles.forEach((content, seq) =>
      this.rows.push({
        id: `${groupId}-${seq}`,
        tenantId: 't',
        connectionId: 'c1',
        conversationId: `conv-${chat}`,
        phoneNumber: chat,
        groupId,
        seq,
        bubbleCount: bubbles.length,
        content,
        tokensUsed: 0,
        imageVerified: null,
        waMessageId: null,
        status: OutboundReplyStatus.PENDING,
        attempts: 0,
        nextAttemptAt: new Date(Date.now() - 1),
        expiresAt: new Date(Date.now() + 3 * 3600_000),
        lastError: null,
        createdAt: new Date(Date.now() + this.n * 0.001 + seq * 0.0001),
        updatedAt: new Date(),
        answeredUntil: null,
        supersedable: true,
      }),
    );
  }
  private live = (r: Row) =>
    r.status === OutboundReplyStatus.PENDING ||
    r.status === OutboundReplyStatus.SENDING;
  resetStale = async () => 0;
  expireDue = async () => [] as Row[];
  dueConnections = async (now: Date) => [
    ...new Set(
      this.rows
        .filter(
          (r) =>
            r.status === OutboundReplyStatus.PENDING && r.nextAttemptAt <= now,
        )
        .map((r) => r.connectionId),
    ),
  ];
  nextDue = async () =>
    this.rows
      .filter(this.live)
      .sort(
        (a, b) =>
          a.createdAt.getTime() - b.createdAt.getTime() || a.seq - b.seq,
      )
      .map((r) => ({ ...r }));
  claim = async (id: string) => {
    const row = this.rows.find((r) => r.id === id)!;
    if (row.status !== OutboundReplyStatus.PENDING) return false;
    row.status = OutboundReplyStatus.SENDING;
    return true;
  };
  setWaMessageId = async (id: string, waId: string) => {
    this.rows.find((r) => r.id === id)!.waMessageId = waId;
  };
  markSent = async (id: string) => {
    this.rows.find((r) => r.id === id)!.status = OutboundReplyStatus.SENT;
  };
  release = async () => undefined;
  markFailed = async () => undefined;
  failRestOfGroup = async () => undefined;
  groupRows = async (groupId: string) =>
    this.rows.filter((r) => r.groupId === groupId).map((r) => ({ ...r }));
  statusOf = async (id: string) =>
    this.rows.find((r) => r.id === id)?.status ?? null;
  supersedeGroup = async () => 0;
  markInboundUnanswered = async () => 0;
  tenantOf = async () => 't';
}

interface Sent {
  at: number;
  chat: string;
  length: number;
}

interface Outcome {
  latencies: number[];
  gaps: number[];
  crossChatGaps: number[];
  sends: Sent[];
}

async function simulate(
  variant: Variant,
  arrivals: Array<{ chat: string; readyAt: number; bubbles: number[] }>,
  seed = 11,
  horizonMs = 15 * 60_000,
): Promise<Outcome> {
  const rng = seeded(seed);
  jest.spyOn(Math, 'random').mockImplementation(rng);
  jest.useFakeTimers({ now: START, doNotFake: ['nextTick', 'setImmediate'] });
  typing.fn = (length) => {
    const [lo, hi] = variant.typingMsPerChar;
    const raw = length * (lo + rng() * (hi - lo));
    return Math.round(
      Math.min(variant.typingCapMs, Math.max(1200, raw)) * (0.9 + rng() * 0.25),
    );
  };

  const t0 = Date.now();
  const sends: Sent[] = [];
  const sock = {
    sendPresenceUpdate: jest.fn(() => Promise.resolve()),
    sendMessage: jest.fn((jid: string, content: { text: string }) => {
      sends.push({
        at: Date.now() - t0,
        chat: jid.split('@')[0],
        length: content.text.length,
      });
      return Promise.resolve({ key: { id: `K${sends.length}` }, message: {} });
    }),
  };
  const limiter = new BaileysRateLimiter('c1', WarmupLevel.NORMAL);
  Object.assign(limiter as unknown as Record<string, number>, {
    CROSS_CHAT_MS_PER_CHAR: variant.crossChat.msPerChar,
    CROSS_CHAT_MIN_MS: variant.crossChat.minMs,
    CROSS_CHAT_MAX_MS: variant.crossChat.maxMs,
  });
  const session = {
    isConnected: () => true,
    get: () => ({ ...sock, user: { id: '57300@s.whatsapp.net' } }),
  };
  const plugin = new BaileysPlugin(
    { get: () => limiter } as never,
    session as never,
    { register: jest.fn() } as never,
    {
      campaignGate: () => Promise.resolve({ allowed: true }),
      cachedExistence: () => Promise.resolve(true),
    } as never,
    { remember: jest.fn() } as never,
  );
  const outbox = new Outbox();
  const dispatcher = new OutboundReplyDispatcher(
    outbox as never,
    plugin as never,
    session as never,
    {
      saveOutbound: jest.fn().mockResolvedValue(undefined),
      hasNewInboundSince: jest.fn().mockResolvedValue(false),
    } as never,
    { publish: jest.fn() } as never,
    { report: jest.fn() } as never,
    { isTyping: () => false } as never,
  );
  (dispatcher as unknown as { logger: object }).logger = {
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };

  const pending = [...arrivals].sort((a, b) => a.readyAt - b.readyAt);
  for (let elapsed = 0; elapsed <= horizonMs; elapsed += 500) {
    while (pending.length && pending[0].readyAt <= elapsed) {
      const next = pending.shift()!;
      outbox.add(
        next.chat,
        next.bubbles.map((n) => 'x'.repeat(n)),
      );
    }
    void dispatcher.tick();
    await jest.advanceTimersByTimeAsync(500);
    if (!pending.length && outbox.rows.every((r) => r.status === 'SENT')) break;
  }

  jest.useRealTimers();
  jest.restoreAllMocks();

  const first = new Map<string, number>();
  const last = new Map<string, number>();
  for (const s of sends) {
    if (!first.has(s.chat)) first.set(s.chat, s.at);
    last.set(s.chat, s.at);
  }
  const gaps: number[] = [];
  const crossChatGaps: number[] = [];
  for (let i = 1; i < sends.length; i++) {
    const gap = sends[i].at - sends[i - 1].at;
    gaps.push(gap);
    if (sends[i].chat !== sends[i - 1].chat) crossChatGaps.push(gap);
  }
  const latencies = arrivals.map((a) => (last.get(a.chat) ?? NaN) - 0);
  return { latencies, gaps, crossChatGaps, sends };
}

const pct = (values: number[], p: number) => {
  const sorted = [...values]
    .filter((v) => !Number.isNaN(v))
    .sort((a, b) => a - b);
  if (!sorted.length) return NaN;
  return sorted[
    Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  ];
};
const s = (ms: number) =>
  Number.isNaN(ms) || ms >= 1e9 ? '-' : (ms / 1000).toFixed(1);

function simultaneous(clients: number, seed: number) {
  const rng = seeded(seed);
  return Array.from({ length: clients }, (_, i) => {
    const arrived = rng() * 1000;
    const debounce = 8000 * (0.75 + rng() * 0.5);
    const work = Math.max(1000 + rng() * 3000, 2000 + rng() * 6000);
    return {
      chat: `5730000000${String(i).padStart(2, '0')}`,
      readyAt: arrived + debounce + work,
      bubbles: [Math.round(80 + rng() * 220)],
    };
  });
}

describe('perfil de ritmo de envío (código real, reloj simulado)', () => {
  jest.setTimeout(120_000);
  const report = process.env.CADENCE_REPORT === '1';

  it('un cliente: nunca una respuesta instantánea y el "escribiendo" dura lo que corresponde', async () => {
    const out = await simulate(CURRENT, simultaneous(1, 3));
    const waited = out.sends[0].at;

    expect(out.sends).toHaveLength(1);
    expect(waited).toBeGreaterThan(9_000);
    expect(waited).toBeLessThan(30_000);
  });

  it('varios clientes a la vez: las respuestas salen de una en una, nunca juntas', async () => {
    const out = await simulate(CURRENT, simultaneous(5, 5));

    expect(out.sends).toHaveLength(5);
    expect(Math.min(...out.gaps)).toBeGreaterThanOrEqual(6_000);
    expect(new Set(out.sends.map((x) => x.chat)).size).toBe(5);
  });

  it('entre chats distintos, tras una respuesta larga pasan al menos ~25 s', async () => {
    const out = await simulate(CURRENT, [
      { chat: '573000000001', readyAt: 1000, bubbles: [300] },
      { chat: '573000000002', readyAt: 1500, bubbles: [300] },
    ]);

    expect(out.crossChatGaps).toHaveLength(1);
    expect(out.crossChatGaps[0]).toBeGreaterThan(25_000);
  });

  it('las burbujas de una misma respuesta salen seguidas, no como si fueran chats distintos', async () => {
    const out = await simulate(CURRENT, [
      { chat: '573000000001', readyAt: 1000, bubbles: [120, 120, 120] },
    ]);

    expect(out.sends).toHaveLength(3);
    expect(Math.max(...out.gaps)).toBeLessThan(15_000);
  });

  (report ? it : it.skip)('tabla comparativa de variantes', async () => {
    const variants: Variant[] = [
      {
        name: 'antes de B (sin pausa entre chats)',
        typingMsPerChar: [45, 70],
        typingCapMs: 5000,
        crossChat: { msPerChar: 0, minMs: 0, maxMs: 0 },
      },
      CURRENT,
      {
        name: 'B + tipeo 90-130 ms/car, tope 9 s',
        typingMsPerChar: [90, 130],
        typingCapMs: 9000,
        crossChat: { msPerChar: 120, minMs: 6000, maxMs: 30000 },
      },
      {
        name: 'B suave (80 ms/car, 5-20 s) + tipeo 90-130, tope 9 s',
        typingMsPerChar: [90, 130],
        typingCapMs: 9000,
        crossChat: { msPerChar: 80, minMs: 5000, maxMs: 20000 },
      },
    ];
    const lines: string[] = [];
    lines.push(
      'variante | clientes | 1.º resp | mediana | última | envío→envío mín | envío→envío mediana | entre chats mín',
    );
    for (const v of variants) {
      for (const n of [1, 2, 5, 10]) {
        const runs: Outcome[] = [];
        for (let seed = 1; seed <= 6; seed++) {
          runs.push(await simulate(v, simultaneous(n, seed), seed));
        }
        const firsts = runs.map((r) => Math.min(...r.sends.map((x) => x.at)));
        const lasts = runs.map((r) => Math.max(...r.sends.map((x) => x.at)));
        const mids = runs.flatMap((r) => r.sends.map((x) => x.at));
        const gaps = runs.flatMap((r) => r.gaps);
        const cross = runs.flatMap((r) => r.crossChatGaps);
        lines.push(
          `${v.name} | ${n} | ${s(pct(firsts, 50))} | ${s(pct(mids, 50))} | ${s(pct(lasts, 50))} | ${s(Math.min(...gaps, 1e9))} | ${s(pct(gaps, 50))} | ${s(Math.min(...cross, 1e9))}`,
        );
      }
    }
    process.stdout.write(`\n${lines.join('\n')}\n`);
    expect(lines.length).toBeGreaterThan(1);
  });
});
