jest.mock('@whiskeysockets/baileys', () => ({
  __esModule: true,
  default: jest.fn(),
  downloadMediaMessage: jest.fn(),
  DisconnectReason: { loggedOut: 401 },
  fetchLatestBaileysVersion: jest.fn(),
  makeCacheableSignalKeyStore: jest.fn(),
  generateMessageIDV2: jest.fn(() => `WA-${++idSeq}`),
  BufferJSON: {},
  initAuthCreds: jest.fn(),
  proto: {},
}));
let idSeq = 0;

import { OutboundReplyDispatcher } from 'src/channels/whatsapp/outbox/OutboundReplyDispatcher';
import { OutboundReplyStatus } from '@prisma/client';

type Row = {
  id: string;
  tenantId: string;
  connectionId: string;
  conversationId: string | null;
  phoneNumber: string;
  groupId: string;
  seq: number;
  bubbleCount: number;
  content: string;
  tokensUsed: number;
  imageVerified: boolean | null;
  waMessageId: string | null;
  status: OutboundReplyStatus;
  attempts: number;
  nextAttemptAt: Date;
  expiresAt: Date;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
};

class FakeOutbox {
  rows: Row[] = [];
  unanswered: string[] = [];
  private n = 0;

  add(
    conversationId: string,
    phone: string,
    bubbles: string[],
    extra: Partial<Row> = {},
  ): string {
    const groupId = `g${++this.n}`;
    const base = Date.now() + this.n * 1000;
    bubbles.forEach((content, seq) =>
      this.rows.push({
        id: `${groupId}-${seq}`,
        tenantId: 't',
        connectionId: 'c1',
        conversationId,
        phoneNumber: phone,
        groupId,
        seq,
        bubbleCount: bubbles.length,
        content,
        tokensUsed: 5,
        imageVerified: null,
        waMessageId: null,
        status: OutboundReplyStatus.PENDING,
        attempts: 0,
        nextAttemptAt: new Date(Date.now() - 1),
        expiresAt: new Date(Date.now() + 30 * 60_000),
        lastError: null,
        createdAt: new Date(base + seq),
        updatedAt: new Date(),
        ...extra,
      }),
    );
    return groupId;
  }

  private live = (r: Row) =>
    r.status === OutboundReplyStatus.PENDING ||
    r.status === OutboundReplyStatus.SENDING;

  resetStale = async (now: Date) => {
    this.rows
      .filter(
        (r) =>
          r.status === OutboundReplyStatus.SENDING &&
          r.updatedAt.getTime() < now.getTime() - 120_000,
      )
      .forEach((r) => (r.status = OutboundReplyStatus.PENDING));
    return 0;
  };
  expireDue = async (now: Date) => {
    const due = this.rows.filter(
      (r) => r.status === OutboundReplyStatus.PENDING && r.expiresAt <= now,
    );
    due.forEach((r) => (r.status = OutboundReplyStatus.EXPIRED));
    return due;
  };
  dueConnections = async (now: Date) => [
    ...new Set(
      this.rows
        .filter(
          (r) =>
            r.status === OutboundReplyStatus.PENDING &&
            r.nextAttemptAt <= now &&
            r.expiresAt > now,
        )
        .map((r) => r.connectionId),
    ),
  ];
  nextDue = async (connectionId: string, now: Date) =>
    this.rows
      .filter(
        (r) =>
          r.connectionId === connectionId && this.live(r) && r.expiresAt > now,
      )
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
  release = async (
    id: string,
    o: { delayMs: number; countAttempt: boolean; error?: string },
  ) => {
    const row = this.rows.find((r) => r.id === id)!;
    row.status = OutboundReplyStatus.PENDING;
    row.nextAttemptAt = new Date(Date.now() + o.delayMs);
    row.lastError = o.error ?? null;
    if (o.countAttempt) row.attempts++;
  };
  markFailed = async (id: string, error: string) => {
    const row = this.rows.find((r) => r.id === id)!;
    row.status = OutboundReplyStatus.FAILED;
    row.lastError = error;
    row.attempts++;
  };
  failRestOfGroup = async (groupId: string, afterSeq: number) => {
    this.rows
      .filter((r) => r.groupId === groupId && r.seq > afterSeq && this.live(r))
      .forEach((r) => (r.status = OutboundReplyStatus.FAILED));
  };
  groupRows = async (groupId: string) =>
    this.rows
      .filter((r) => r.groupId === groupId)
      .sort((a, b) => a.seq - b.seq)
      .map((r) => ({ ...r }));
  markInboundUnanswered = async (conversationId: string) => {
    this.unanswered.push(conversationId);
    return 1;
  };
  tenantOf = async () => 't';
  status = (id: string) => this.rows.find((r) => r.id === id)!.status;
}

function setup() {
  const outbox = new FakeOutbox();
  const sends: Array<{ to: string; content: string; messageId?: string }> = [];
  const script: Array<
    (p: { to: string; content: string }) => Record<string, unknown> | undefined
  > = [];
  const plugin = {
    providerName: 'baileys',
    send: jest.fn((p: { to: string; content: string; messageId?: string }) => {
      sends.push({ to: p.to, content: p.content, messageId: p.messageId });
      const scripted = script.shift()?.(p);
      return Promise.resolve(
        scripted ?? { success: true, provider: 'baileys', raw: null },
      );
    }),
  };
  const connected = { value: true };
  const session = {
    isConnected: () => connected.value,
    get: () => ({ user: { id: '57300@s.whatsapp.net' } }),
  };
  const conversations = {
    saveOutbound: jest.fn().mockResolvedValue(undefined),
  };
  const eventBus = { publish: jest.fn() };
  const alerts = { report: jest.fn() };
  const dispatcher = new OutboundReplyDispatcher(
    outbox as never,
    plugin as never,
    session as never,
    conversations as never,
    eventBus as never,
    alerts as never,
  );
  (dispatcher as unknown as { logger: object }).logger = {
    error: jest.fn(),
    warn: jest.fn(),
  };
  return {
    outbox,
    sends,
    script,
    connected,
    conversations,
    alerts,
    dispatcher,
  };
}

const failure = (extra: Record<string, unknown>) => () => ({
  success: false,
  provider: 'baileys',
  raw: null,
  ...extra,
});

describe('OutboundReplyDispatcher', () => {
  it('entrega las burbujas en orden y guarda lo enviado como un solo mensaje', async () => {
    const w = setup();
    w.outbox.add('conv-1', '573001', ['Uno.', 'Dos.']);
    await w.dispatcher.tick();
    expect(w.sends.map((s) => s.content)).toEqual(['Uno.', 'Dos.']);
    expect(w.conversations.saveOutbound).toHaveBeenCalledTimes(1);
    expect(w.conversations.saveOutbound).toHaveBeenCalledWith(
      'conv-1',
      'Uno.\n\nDos.',
      expect.objectContaining({ connectionId: 'c1', tokensUsed: 5 }),
    );
    expect(w.alerts.report).not.toHaveBeenCalled();
  });

  it('desconectado: las respuestas esperan en cola y al reconectar salen en orden, una sola vez cada una', async () => {
    const w = setup();
    w.connected.value = false;
    w.outbox.add('conv-1', '573001', ['A1.']);
    w.outbox.add('conv-2', '573002', ['B1.']);
    w.outbox.add('conv-1', '573001', ['A2.']);
    await w.dispatcher.tick();
    expect(w.sends).toEqual([]);
    expect(w.outbox.rows.every((r) => r.attempts === 0)).toBe(true);

    w.connected.value = true;
    await w.dispatcher.tick();
    await w.dispatcher.tick();
    expect(w.sends.map((s) => s.content)).toEqual(['A1.', 'B1.', 'A2.']);
    expect(
      w.outbox.rows.every((r) => r.status === OutboundReplyStatus.SENT),
    ).toBe(true);
  });

  it('si el canal cae justo al enviar, espera sin gastar intentos y reenvía con el mismo id', async () => {
    const w = setup();
    w.outbox.add('conv-1', '573001', ['Hola']);
    w.script.push(
      failure({ retryable: true, errorCode: 'WHATSAPP_NOT_CONNECTED' }),
    );
    await w.dispatcher.tick();
    const row = w.outbox.rows[0];
    expect(row.status).toBe(OutboundReplyStatus.PENDING);
    expect(row.attempts).toBe(0);
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());

    row.nextAttemptAt = new Date(Date.now() - 1);
    await w.dispatcher.tick();
    expect(w.sends).toHaveLength(2);
    expect(w.sends[0].messageId).toBeDefined();
    expect(w.sends[1].messageId).toBe(w.sends[0].messageId);
    expect(row.status).toBe(OutboundReplyStatus.SENT);
  });

  it('un fallo transitorio reintenta con backoff; agotados los intentos queda FAILED con aviso', async () => {
    const w = setup();
    w.outbox.add('conv-1', '573001', ['Uno.', 'Dos.']);
    for (let i = 0; i < 6; i++) {
      w.script.push(
        failure({
          retryable: true,
          errorCode: 'CONNECTION_ERROR',
          error: 'timed out',
        }),
      );
    }
    for (let i = 0; i < 6; i++) {
      await w.dispatcher.tick();
      const row = w.outbox.rows[0];
      if (row.status === OutboundReplyStatus.PENDING) {
        expect(row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
        row.nextAttemptAt = new Date(Date.now() - 1);
      }
    }
    expect(w.outbox.rows[0].status).toBe(OutboundReplyStatus.FAILED);
    expect(w.outbox.rows[1].status).toBe(OutboundReplyStatus.FAILED);
    expect(w.sends.every((s) => s.content === 'Uno.')).toBe(true);
    expect(w.conversations.saveOutbound).not.toHaveBeenCalled();
    expect(w.outbox.unanswered).toEqual(['conv-1']);
    expect(w.alerts.report).toHaveBeenCalledWith(
      't',
      'undelivered',
      expect.stringContaining('573001'),
    );
  });

  it('una burbuja que falla para siempre no deja salir las siguientes, y guarda solo lo entregado', async () => {
    const w = setup();
    w.outbox.add('conv-1', '573001', ['Primera.', 'Segunda.', 'Tercera.']);
    w.script.push(() => undefined);
    w.script.push(
      failure({
        retryable: false,
        errorCode: 'SEND_FAILED',
        error: 'rechazado',
      }),
    );
    await w.dispatcher.tick();
    expect(w.sends.map((s) => s.content)).toEqual(['Primera.', 'Segunda.']);
    expect(w.outbox.rows.map((r) => r.status)).toEqual([
      OutboundReplyStatus.SENT,
      OutboundReplyStatus.FAILED,
      OutboundReplyStatus.FAILED,
    ]);
    expect(w.conversations.saveOutbound).toHaveBeenCalledWith(
      'conv-1',
      'Primera.',
      expect.anything(),
    );
    expect(w.outbox.unanswered).toEqual([]);
    expect(w.alerts.report).toHaveBeenCalledWith(
      't',
      'undelivered',
      expect.stringContaining('incompleta'),
    );
  });

  it('un reintento pendiente en un chat no adelanta su siguiente mensaje, pero no frena a los demás', async () => {
    const w = setup();
    w.outbox.add('conv-A', '573001', ['A1.']);
    w.outbox.add('conv-A', '573001', ['A2.']);
    w.outbox.add('conv-B', '573002', ['B1.']);
    w.script.push(
      failure({
        retryable: true,
        errorCode: 'CONNECTION_ERROR',
        error: 'closed',
      }),
    );
    await w.dispatcher.tick();
    expect(w.sends.map((s) => s.content)).toEqual(['A1.', 'B1.']);
    expect(w.outbox.rows.find((r) => r.content === 'A2.')!.status).toBe(
      OutboundReplyStatus.PENDING,
    );
  });

  it('caducidad: no envía una respuesta vieja, la marca, deja los mensajes sin contestar solos y avisa', async () => {
    const w = setup();
    w.outbox.add('conv-1', '573001', ['Vieja.'], {
      expiresAt: new Date(Date.now() - 1_000),
    });
    await w.dispatcher.tick();
    expect(w.sends).toEqual([]);
    expect(w.outbox.rows[0].status).toBe(OutboundReplyStatus.EXPIRED);
    expect(w.conversations.saveOutbound).not.toHaveBeenCalled();
    expect(w.outbox.unanswered).toEqual(['conv-1']);
    expect(w.alerts.report).toHaveBeenCalledWith(
      't',
      'undelivered',
      expect.stringContaining('573001'),
    );
  });

  it('un envío que quedó a medias por un reinicio vuelve a la cola y sale con el mismo id', async () => {
    const w = setup();
    w.outbox.add('conv-1', '573001', ['Hola'], {
      status: OutboundReplyStatus.SENDING,
      waMessageId: 'WA-PREVIO',
      updatedAt: new Date(Date.now() - 5 * 60_000),
    });
    await w.dispatcher.tick();
    expect(w.sends).toHaveLength(1);
    expect(w.sends[0].messageId).toBe('WA-PREVIO');
  });

  it('dos ciclos simultáneos no envían dos veces', async () => {
    const w = setup();
    w.outbox.add('conv-1', '573001', ['Hola']);
    await Promise.all([w.dispatcher.tick(), w.dispatcher.tick()]);
    expect(w.sends).toHaveLength(1);
  });
});
