jest.mock('@whiskeysockets/baileys', () => ({
  __esModule: true,
  default: jest.fn(),
  downloadMediaMessage: jest.fn(),
  DisconnectReason: { loggedOut: 401 },
  fetchLatestBaileysVersion: jest.fn(),
  makeCacheableSignalKeyStore: jest.fn(),
  BufferJSON: {},
  initAuthCreds: jest.fn(),
  proto: {},
}));

import { EventEmitter } from 'events';
import { BotStatus } from '@prisma/client';
import { BotRouter } from 'src/bot/router/BotRouter';
import { MessageDebouncer } from 'src/bot/router/MessageDebouncer';
import { messageReceiptTracker } from 'src/channels/whatsapp/baileys/MessageReceiptTracker';
import { BaileysSessionManager } from 'src/channels/whatsapp/baileys/BaileysSessionManager';
import { EVENT_TYPES } from 'src/infra/events/constants/event.types';
import { ReplyMetricsService } from 'src/bot/router/reply-metrics.service';

const CONN = '1e93c204-5e78-4dca-bd5c-cbda632c91c9';
const BOT = 'bot-1';
const TENANT = 'tenant-1';
const A = '573000000001';
const B = '573000000002';
const DELAY_MS = 8_000;

const later = <A extends unknown[], R>(fn: (...args: A) => R) =>
  jest.fn((...args: A) => Promise.resolve(fn(...args)));

interface StoredMessage {
  id: string;
  conversationId: string;
  direction: 'INBOUND' | 'OUTBOUND';
  content: string;
  processedBy: string;
  waMessageId?: string;
  createdAt: number;
}

class Store {
  lastOutboundValue: { content: string; at: Date } | null = null;
  resets: Array<{ id: string; since: Date }> = [];
  conversations = new Map<
    string,
    {
      id: string;
      phoneNumber: string;
      botConfigId: string;
      lastConnectionId: string;
      context: Record<string, unknown>;
    }
  >();
  messages: StoredMessage[] = [];
  private seq = 0;

  conversationOf(phone: string) {
    return [...this.conversations.values()].find(
      (c) => c.phoneNumber === phone,
    );
  }

  inboundTexts(phone: string): string[] {
    const conv = this.conversationOf(phone);
    return this.messages
      .filter((m) => m.conversationId === conv?.id && m.direction === 'INBOUND')
      .map((m) => m.content);
  }

  service() {
    return {
      getOrCreate: later(
        (dto: {
          botConfigId: string;
          phoneNumber: string;
          connectionId: string;
        }) => {
          let conv = this.conversationOf(dto.phoneNumber);
          if (!conv) {
            conv = {
              id: `conv-${dto.phoneNumber}`,
              phoneNumber: dto.phoneNumber,
              botConfigId: dto.botConfigId,
              lastConnectionId: dto.connectionId,
              context: {},
            };
            this.conversations.set(conv.id, conv);
          }
          return conv;
        },
      ),
      findById: later((id: string) => this.conversations.get(id)),
      saveInbound: later(
        (
          conversationId: string,
          content: string,
          ...rest: [
            boolean?,
            string?,
            { waMessageId?: string; processedBy?: string }?,
          ]
        ) => {
          const options = rest[2];
          const waMessageId = options?.waMessageId;
          if (
            waMessageId &&
            this.messages.some(
              (m) =>
                m.conversationId === conversationId &&
                m.waMessageId === waMessageId,
            )
          ) {
            return { created: false };
          }
          this.messages.push({
            id: `m${++this.seq}`,
            conversationId,
            direction: 'INBOUND',
            content,
            processedBy: options?.processedBy ?? 'user',
            waMessageId,
            createdAt: Date.now(),
          });
          return { created: true };
        },
      ),
      saveOutbound: later((conversationId: string, content: string) => {
        this.messages.push({
          id: `m${++this.seq}`,
          conversationId,
          direction: 'OUTBOUND',
          content,
          processedBy: 'bot',
          createdAt: Date.now(),
        });
      }),
      saveHumanOutbound: later((conversationId: string, content: string) => {
        this.messages.push({
          id: `m${++this.seq}`,
          conversationId,
          direction: 'OUTBOUND',
          content,
          processedBy: 'human',
          createdAt: Date.now(),
        });
      }),
      findActiveByPhone: later(
        (_bot: string, phone: string) => this.conversationOf(phone) ?? null,
      ),
      findConversationsWithPending: later(() =>
        [...this.conversations.values()].filter(
          (c) => this.pendingOf(c.id).length > 0,
        ),
      ),
      getConversationForAI: later((conversationId: string) => ({
        context: this.conversations.get(conversationId)?.context ?? {},
        currentStep: null,
        lastIntent: null,
        history: [],
        leadingBotMessages: [],
        pending: this.pendingOf(conversationId).map((m) => ({
          id: m.id,
          content: m.content,
          hasImage: false,
        })),
        summary: null,
      })),
      acquireLock: later(() => true),
      releaseLock: later(() => undefined),
      isBotPaused: jest.fn(() => false),
      countBotRepliesSince: later(() => 0),
      lastOutboundContent: later(() => null),
      lastOutbound: later(() => this.lastOutboundValue),
      resetConversation: later((id: string, since: Date) => {
        this.resets.push({ id, since });
        const conv = this.conversations.get(id);
        if (conv)
          conv.context = { ...conv.context, closedAt: since.toISOString() };
      }),
      findLastHumanMessage: later(
        (_bot: string, phone: string, cutoff: Date) => {
          const conv = this.conversationOf(phone);
          return (
            this.messages.find(
              (m) =>
                m.conversationId === conv?.id &&
                m.processedBy === 'human' &&
                m.createdAt >= cutoff.getTime(),
            ) ?? null
          );
        },
      ),
      updateContext: later(
        (
          conversationId: string,
          update: { contextPatch?: Record<string, unknown> },
        ) => {
          const conversation = this.conversations.get(conversationId);
          if (conversation && update.contextPatch) {
            conversation.context = {
              ...conversation.context,
              ...update.contextPatch,
            };
          }
        },
      ),
      appendActionMemory: later(() => undefined),
    };
  }

  pendingOf(conversationId: string): StoredMessage[] {
    const own = this.messages.filter(
      (m) => m.conversationId === conversationId,
    );
    let last = -1;
    own.forEach((m, i) => {
      if (m.direction === 'OUTBOUND') last = i;
    });
    return own
      .slice(last + 1)
      .filter((m) => m.direction === 'INBOUND' && m.processedBy !== 'ignored');
  }
}

function world(
  store = new Store(),
  ai: (
    userMessage: string,
    call: number,
  ) =>
    | string
    | {
        content: string;
        stopReason?: string;
        toolCallsExecuted?: Array<{
          name: string;
          arguments: object;
          ok: boolean;
        }>;
      } = (m) => `respuesta a: ${m}`,
) {
  const metrics = new ReplyMetricsService();
  let promptMaxTokens = 400;
  let notifyResult = true;
  const slimPrompts: unknown[] = [];
  const afterSlimTurn = jest.fn(() => Promise.resolve());
  let activeTools: unknown[] = [];
  const intentHandle = jest.fn((_turn?: unknown) =>
    Promise.resolve({ handled: false }),
  );
  const notifications: unknown[][] = [];
  const sends: Array<{ to: string; content: string; conversationId: string }> =
    [];
  const aiCalls: string[] = [];
  const aiInputs: Array<{
    userMessage: string;
    reasoningMode?: string;
    maxTokens?: number;
  }> = [];
  const conversations = store.service();
  const debouncer = new MessageDebouncer();
  const tracker = new messageReceiptTracker();
  const socket = {
    readMessages: later(() => undefined),
    presenceSubscribe: later(() => undefined),
  };
  const sessionManager = { get: () => socket };
  const eventBus = {
    publish: jest.fn(),
    publishAsync: jest.fn(
      async (
        type: string,
        payload: {
          phoneNumber: string;
          content: string;
          conversationId: string;
        },
      ) => {
        if (type !== EVENT_TYPES.CHANNEL_SEND_REQUESTED) return;
        sends.push({
          to: payload.phoneNumber,
          content: payload.content,
          conversationId: payload.conversationId,
        });
        await conversations.saveOutbound(
          payload.conversationId,
          payload.content,
        );
      },
    ),
  };
  const botConfig = {
    id: BOT,
    tenantId: TENANT,
    name: 'Bot',
    status: BotStatus.ACTIVE,
    botResponseDelaySeconds: DELAY_MS / 1000,
    maxHistoryMessages: 10,
    humanTakeoverMinutes: 10,
    maxMessageAgeMinutes: 1440,
    imageAnalysisEnabled: false,
    aiModels: [{ id: 'm1' }],
  };
  const router = new BotRouter(
    sessionManager as never,
    {
      getConfigForRouting: later(() => botConfig),
      findActiveForTenant: later(() => botConfig),
    } as never,
    conversations as never,
    eventBus as never,
    {
      generateResponse: later(
        (input: {
          userMessage: string;
          reasoningMode?: string;
          maxTokens?: number;
        }) => {
          aiCalls.push(input.userMessage);
          aiInputs.push(input);
          const out = ai(input.userMessage, aiCalls.length);
          return {
            tokensUsed: 10,
            toolCallsExecuted: [],
            ...(typeof out === 'string' ? { content: out } : out),
          };
        },
      ),
    } as never,
    {} as never,
    tracker,
    debouncer,
    {
      buildConversationPrompt: later(() => ({
        systemPrompt: '',
        maxTokens: promptMaxTokens,
        temperature: 0.7,
      })),
      buildSlimPrompt: later((_bot: string, plan: unknown) => {
        slimPrompts.push(plan);
        return {
          systemPrompt: 'slim',
          maxTokens: promptMaxTokens,
          temperature: 0.7,
        };
      }),
    } as never,
    { getActiveToolsForBot: later(() => activeTools) } as never,
    {} as never,
    {
      notifyToolFailure: later(() => notifyResult),
    } as never,
    { refreshIfNeeded: later(() => undefined) } as never,
    metrics,
    {
      report: (...args: unknown[]) => {
        notifications.push(args);
      },
    } as never,
    { handle: intentHandle, afterSlimTurn } as never,
  );
  (router as unknown as { logger: object }).logger = {
    debug: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };

  const ev = new EventEmitter();
  const manager = Object.create(
    BaileysSessionManager.prototype,
  ) as BaileysSessionManager;
  Object.assign(manager, {
    logger: {
      debug: jest.fn(),
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
    receiptTracker: tracker,
    botRouter: router,
    botSentRegistry: { consume: () => false, register: jest.fn() },
    contacts: {
      recordInbound: later(() => undefined),
      findAddressByLid: later(() => null),
    },
    chatAddresses: new Map(),
  });
  const state = {
    botConfigId: BOT,
    tenantId: TENANT,
    reconnectCount: 1,
    lastReconnectAt: null,
    connectedAt: Date.now(),
    connected: true,
    stopped: false,
  };
  (manager as unknown as { bindEvents: (...a: unknown[]) => void }).bindEvents(
    CONN,
    {
      ev: {
        on: (event: string, handler: (...a: unknown[]) => void) =>
          ev.on(event, handler),
      },
      presenceSubscribe: socket.presenceSubscribe,
    },
    state,
    jest.fn(),
  );

  let seq = 0;
  const inbound = (phone: string, text: string, id = `WA${++seq}`) => {
    ev.emit('messages.upsert', {
      type: 'notify',
      messages: [
        {
          key: { remoteJid: `${phone}@s.whatsapp.net`, fromMe: false, id },
          messageTimestamp: Math.floor(Date.now() / 1000),
          message: { conversation: text },
        },
      ],
    });
    return id;
  };
  const ownerReads = (phone: string) =>
    ev.emit('messages.update', [
      {
        key: {
          remoteJid: `${phone}@s.whatsapp.net`,
          fromMe: true,
          id: `OWN${++seq}`,
        },
        update: { status: 3 },
      },
    ]);
  const ownerWrites = (phone: string, text: string) =>
    ev.emit('messages.upsert', {
      type: 'notify',
      messages: [
        {
          key: {
            remoteJid: `${phone}@s.whatsapp.net`,
            fromMe: true,
            id: `OWN${++seq}`,
          },
          messageTimestamp: Math.floor(Date.now() / 1000),
          message: { conversation: text },
        },
      ],
    });
  const clientTyping = (phone: string) =>
    ev.emit('presence.update', {
      id: `${phone}@s.whatsapp.net`,
      presences: {
        [`${phone}@s.whatsapp.net`]: { lastKnownPresence: 'composing' },
      },
    });

  return {
    store,
    router,
    sends,
    metrics,
    notifications,
    intentHandle,
    slimPrompts,
    afterSlimTurn,
    setTools: (names: string[]) => {
      activeTools = names.map((name) => ({
        spec: { name },
        definitionId: `def-${name}`,
        readOnly: true,
        requiresImageAttachment: false,
        imageParamName: null,
        maxImageSizeBytes: null,
        injectPhoneParamName: null,
        pausesBotMinutes: null,
      }));
    },
    setNotifyResult: (value: boolean) => {
      notifyResult = value;
    },
    setMaxTokens: (value: number) => {
      promptMaxTokens = value;
    },
    aiCalls,
    aiInputs,
    inbound,
    ownerReads,
    ownerWrites,
    clientTyping,
    tracker,
  };
}

const settle = async (ms: number) => {
  await jest.advanceTimersByTimeAsync(ms);
};

describe('Aislamiento de chats (etapa 1)', () => {
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('dos chats que escriben con 1 s de diferencia producen dos turnos, cada uno con sus textos y su respuesta', async () => {
    const w = world();
    w.inbound(A, 'Hola, precio del spa coreano');
    await settle(1_000);
    w.inbound(B, 'Buenas, ¿dónde quedan?');
    await settle(DELAY_MS + 2_000);

    expect(w.store.inboundTexts(A)).toEqual(['Hola, precio del spa coreano']);
    expect(w.store.inboundTexts(B)).toEqual(['Buenas, ¿dónde quedan?']);
    expect(w.sends.filter((s) => s.to === A).map((s) => s.content)).toEqual([
      'respuesta a: Hola, precio del spa coreano',
    ]);
    expect(w.sends.filter((s) => s.to === B).map((s) => s.content)).toEqual([
      'respuesta a: Buenas, ¿dónde quedan?',
    ]);
  });

  it('una ráfaga del mismo chat se responde en un solo turno con todos sus textos', async () => {
    const w = world();
    w.inbound(A, 'hola');
    await settle(1_000);
    w.inbound(A, 'quiero una cita');
    await settle(DELAY_MS + 2_000);

    expect(w.aiCalls).toEqual(['hola\nquiero una cita']);
    expect(w.sends.filter((s) => s.to === A)).toHaveLength(1);
  });

  it('el spa activo en A (evento de Baileys) frena solo a A; B no se ve afectado y A se atiende después', async () => {
    const w = world();
    w.ownerReads(A);
    w.inbound(A, 'mensaje de A');
    w.inbound(B, 'mensaje de B');
    await settle(DELAY_MS + 2_000);

    expect(w.sends.filter((s) => s.to === B)).toHaveLength(1);
    expect(w.sends.filter((s) => s.to === A)).toHaveLength(0);
    expect(w.store.inboundTexts(A)).toEqual(['mensaje de A']);

    await settle(120_000);
    expect(w.sends.filter((s) => s.to === A).map((s) => s.content)).toEqual([
      'respuesta a: mensaje de A',
    ]);
  });

  it('la clienta escribiendo (presencia de Baileys) retrasa solo su chat', async () => {
    const w = world();
    w.inbound(A, 'mensaje de A');
    w.inbound(B, 'mensaje de B');
    await settle(DELAY_MS - 500);
    w.clientTyping(A);
    await settle(1_500);

    expect(w.sends.filter((s) => s.to === B)).toHaveLength(1);
    expect(w.sends.filter((s) => s.to === A)).toHaveLength(0);

    await settle(60_000);
    expect(w.sends.filter((s) => s.to === A)).toHaveLength(1);
  });

  it('una persona del spa escribiendo en A no cancela ni pierde lo de B, y lo de A queda guardado', async () => {
    const w = world();
    w.inbound(A, 'mensaje de A');
    w.inbound(B, 'mensaje de B');
    await settle(2_000);
    w.ownerWrites(A, 'Hola, te atiendo yo');
    await settle(DELAY_MS + 2_000);

    expect(w.sends.filter((s) => s.to === B).map((s) => s.content)).toEqual([
      'respuesta a: mensaje de B',
    ]);
    expect(w.store.inboundTexts(A)).toEqual(['mensaje de A']);
    expect(w.sends.filter((s) => s.to === A)).toHaveLength(0);
  });

  it('cada mensaje queda guardado al llegar, antes del debounce', async () => {
    const w = world();
    w.inbound(A, 'guardado de inmediato');
    await settle(10);
    expect(w.store.inboundTexts(A)).toEqual(['guardado de inmediato']);
  });

  it('tras un reinicio, los mensajes sin responder se recuperan desde la base', async () => {
    const store = new Store();
    const before = world(store);
    before.inbound(A, 'escribí justo antes del reinicio');
    await settle(10);
    jest.clearAllTimers();

    const after = world(store);
    await (
      after.router as unknown as {
        recoverPending: (c: string, b: string, t: string) => Promise<number>;
      }
    ).recoverPending(CONN, BOT, TENANT);
    await settle(DELAY_MS + 2_000);

    expect(after.sends.filter((s) => s.to === A).map((s) => s.content)).toEqual(
      ['respuesta a: escribí justo antes del reinicio'],
    );
  });

  it('un mensaje reenviado por WhatsApp con el mismo id se guarda y se responde una sola vez', async () => {
    const store = new Store();
    const first = world(store);
    first.inbound(A, 'hola', 'WA-DUP');
    await settle(10);
    const second = world(store);
    second.inbound(A, 'hola', 'WA-DUP');
    await settle(DELAY_MS + 2_000);

    expect(store.inboundTexts(A)).toEqual(['hola']);
    expect(
      [...first.sends, ...second.sends].filter((s) => s.to === A),
    ).toHaveLength(1);
  });
});

describe('Respuestas vacías de la IA (etapa de tokens)', () => {
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('si la IA devuelve vacío reintenta una vez sin razonamiento y envía esa respuesta', async () => {
    const w = world(new Store(), (m, call) =>
      call === 1 ? '' : `respuesta a: ${m}`,
    );
    w.inbound(A, 'hola');
    await settle(DELAY_MS + 2_000);

    expect(w.aiInputs.map((i) => i.reasoningMode)).toEqual([undefined, 'OFF']);
    expect(w.sends.map((s) => s.content)).toEqual(['respuesta a: hola']);
  });

  it('nunca envía un mensaje vacío: si se repite el vacío avisa que la IA no está disponible', async () => {
    const w = world(new Store(), () => '');
    w.inbound(A, 'hola');
    await settle(DELAY_MS + 2_000);

    expect(w.sends).toHaveLength(1);
    expect(w.sends[0].content).toMatch(/asistente no está disponible/);
  });

  it('una respuesta vacía no dispara la regeneración por "duplicado" sin historial', async () => {
    const store = new Store();
    const w = world(store, (m, call) =>
      call === 2 ? '' : `respuesta a: ${m}`,
    );
    w.inbound(A, 'primera');
    await settle(DELAY_MS + 2_000);
    w.inbound(A, 'segunda');
    await settle(DELAY_MS + 2_000);

    expect(w.aiInputs).toHaveLength(3);
    expect(w.sends.map((s) => s.content)).toEqual([
      'respuesta a: primera',
      'respuesta a: segunda',
    ]);
  });
});

describe('Respuestas cortadas por tope de tokens (etapa 4)', () => {
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('una respuesta cortada se regenera una vez con techo mayor y sin razonamiento', async () => {
    const w = world(new Store(), (m, call) =>
      call === 1
        ? {
            content: 'Te cuento que el tratamiento incluye una limpie',
            stopReason: 'max_tokens',
          }
        : {
            content: 'Te cuento que el tratamiento incluye limpieza completa.',
            stopReason: 'end_turn',
          },
    );
    w.inbound(A, 'hola');
    await settle(DELAY_MS + 2_000);

    expect(w.aiInputs.map((i) => [i.reasoningMode, i.maxTokens])).toEqual([
      [undefined, 400],
      ['OFF', 800],
    ]);
    expect(w.sends.map((s) => s.content)).toEqual([
      'Te cuento que el tratamiento incluye limpieza completa.',
    ]);
    expect(w.metrics.snapshot()).toMatchObject({
      truncated: 1,
      truncatedRecovered: 1,
      truncatedCut: 0,
    });
  });

  it('si la regeneración también se corta, envía hasta la última oración completa', async () => {
    const w = world(new Store(), () => ({
      content:
        'Hola, soy Sofía. Tenemos horario el lunes. Para reservar necesito tu nom',
      stopReason: 'max_tokens',
    }));
    w.inbound(A, 'hola');
    await settle(DELAY_MS + 2_000);

    expect(w.aiInputs).toHaveLength(2);
    expect(w.sends.map((s) => s.content)).toEqual([
      'Hola, soy Sofía. Tenemos horario el lunes.',
    ]);
    expect(w.metrics.snapshot()).toMatchObject({
      truncated: 1,
      truncatedRecovered: 0,
      truncatedCut: 1,
    });
  });

  it('el techo de la regeneración nunca pasa de 2048 tokens', async () => {
    const w = world(new Store(), (m, call) =>
      call === 1
        ? { content: 'Texto cortado', stopReason: 'max_tokens' }
        : 'Texto completo.',
    );
    w.setMaxTokens(1500);
    w.inbound(A, 'hola');
    await settle(DELAY_MS + 2_000);
    expect(w.aiInputs[1].maxTokens).toBe(2048);
  });

  it('un vacío tras la regeneración no se envía y activa el aviso de IA no disponible', async () => {
    const w = world(new Store(), (m, call) =>
      call === 1 ? { content: 'Cortado a med', stopReason: 'max_tokens' } : '',
    );
    w.inbound(A, 'hola');
    await settle(DELAY_MS + 2_000);

    expect(w.sends.every((s) => s.content.trim() !== '')).toBe(true);
    expect(w.sends.map((s) => s.content)).toEqual(['Cortado a med']);
  });

  it('cuenta los vacíos reintentados y recuperados', async () => {
    const w = world(new Store(), (m, call) => (call === 1 ? '   ' : 'Listo.'));
    w.inbound(A, 'hola');
    await settle(DELAY_MS + 2_000);
    expect(w.metrics.snapshot()).toMatchObject({
      empty: 1,
      emptyRecovered: 1,
      emptyFallback: 0,
    });
  });

  it('un reintento por respuesta duplicada que sale vacío no envía una burbuja en blanco', async () => {
    const w = world(new Store(), (m, call) =>
      call === 1
        ? 'Misma respuesta de siempre.'
        : call === 2
          ? 'Misma respuesta de siempre.'
          : call === 3
            ? '\u200B'
            : 'Otra.',
    );
    w.inbound(A, 'uno');
    await settle(DELAY_MS + 2_000);
    w.inbound(A, 'dos');
    await settle(DELAY_MS + 2_000);

    expect(
      w.sends.every((s) => s.content.replace(/[\u200B\s]/g, '') !== ''),
    ).toBe(true);
  });
});

describe('IA no disponible: la clienta siempre recibe respuesta y el equipo se entera de verdad', () => {
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  });
  afterEach(() => {
    jest.useRealTimers();
  });
  const WINDOW_MS = 30 * 60 * 1000;

  it('el primer fallo manda el aviso completo y avisa al equipo', async () => {
    const w = world(new Store(), () => '');
    w.inbound(A, 'hola');
    await settle(DELAY_MS + 2_000);
    expect(w.sends).toHaveLength(1);
    expect(w.sends[0].content).toMatch(/asistente no está disponible/);
    expect(w.notifications).toHaveLength(1);
  });

  it('un segundo fallo dentro de la ventana también responde (aviso corto) y no repite el aviso al equipo ya notificado', async () => {
    const w = world(new Store(), () => '');
    w.inbound(A, 'hola');
    await settle(DELAY_MS + 2_000);
    w.inbound(A, 'sigo aquí');
    await settle(DELAY_MS + 2_000);

    expect(w.sends).toHaveLength(2);
    expect(w.sends[1].content).toMatch(
      /una persona del equipo ya tiene tu mensaje/,
    );
    expect(w.sends.every((s) => s.content.trim() !== '')).toBe(true);
    expect(w.notifications).toHaveLength(1);
  });

  it('pasada la ventana vuelve el aviso completo y se vuelve a avisar al equipo', async () => {
    const w = world(new Store(), () => '');
    w.inbound(A, 'hola');
    await settle(DELAY_MS + 2_000);
    await settle(WINDOW_MS + 1_000);
    w.inbound(A, 'hola de nuevo');
    await settle(DELAY_MS + 2_000);

    expect(w.sends).toHaveLength(2);
    expect(w.sends[1].content).toMatch(/asistente no está disponible/);
    expect(w.notifications).toHaveLength(2);
  });
});

describe('Despachador de intenciones antes de la IA (etapa 5)', () => {
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('si el despachador responde, la IA no se llama y nadie más recibe nada', async () => {
    const w = world(new Store(), () => 'respuesta IA');
    w.intentHandle.mockImplementationOnce((turn: any) =>
      turn.send('respuesta fija').then(() => ({ handled: true })),
    );
    w.inbound(A, 'horario');
    await settle(DELAY_MS + 2_000);
    expect(w.aiCalls).toHaveLength(0);
    expect(w.sends.map((s) => s.content)).toEqual(['respuesta fija']);
  });

  it('si el despachador no decide, el turno sigue a la IA con el mismo texto', async () => {
    const w = world(new Store(), () => 'respuesta IA');
    w.inbound(A, 'quiero agendar un masaje');
    await settle(DELAY_MS + 2_000);
    expect(w.intentHandle).toHaveBeenCalledTimes(1);
    expect(w.aiCalls).toEqual(['quiero agendar un masaje']);
    expect(w.sends.map((s) => s.content)).toEqual(['respuesta IA']);
  });

  it('recibe el texto de la ráfaga unido, el chat verificado y el último mensaje del bot', async () => {
    const w = world(new Store(), () => 'ok');
    w.inbound(A, 'hola');
    w.inbound(A, 'quiero cancelar');
    await settle(DELAY_MS + 2_000);
    const turn = w.intentHandle.mock.calls[0][0] as any;
    expect(turn.text).toBe('hola\nquiero cancelar');
    expect(turn.phoneNumber).toBe(A);
    expect(turn.hasImage).toBe(false);
  });
});

describe('LLM_SLIM en el router (etapa 5)', () => {
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  const plan = {
    intentKey: 'booking',
    prompt: 'Eres un asistente de citas',
    tools: ['listar_tratamientos', 'crear_reserva_whatsapp'],
    via: 'rules',
    endsOnTools: ['crear_reserva_whatsapp'],
  };

  it('usa el prompt reducido y solo las herramientas del manejador', async () => {
    const w = world(new Store(), () => 'ok');
    w.setTools([
      'listar_tratamientos',
      'crear_reserva_whatsapp',
      'registrar_comprobante_automatico',
    ]);
    w.intentHandle.mockImplementationOnce(() =>
      Promise.resolve({ handled: false, slim: plan } as never),
    );
    w.inbound(A, 'quiero agendar');
    await settle(DELAY_MS + 2_000);

    expect(w.slimPrompts).toHaveLength(1);
    expect((w.slimPrompts[0] as { prompt: string }).prompt).toMatch(/citas/);
    const tools = (
      w.aiInputs[0] as unknown as { tools: Array<{ name: string }> }
    ).tools;
    expect(tools.map((t) => t.name)).toEqual([
      'listar_tratamientos',
      'crear_reserva_whatsapp',
    ]);
  });

  it('tras responder avisa al despachador qué herramientas tuvieron éxito para abrir o cerrar el flujo', async () => {
    const w = world(new Store(), () => ({
      content: 'Listo, quedó agendada',
      toolCallsExecuted: [
        { name: 'crear_reserva_whatsapp', arguments: {}, ok: true },
        { name: 'listar_tratamientos', arguments: {}, ok: false },
      ],
    }));
    w.intentHandle.mockImplementationOnce(() =>
      Promise.resolve({ handled: false, slim: plan } as never),
    );
    w.inbound(A, 'quiero agendar');
    await settle(DELAY_MS + 2_000);
    expect(w.afterSlimTurn).toHaveBeenCalledWith('conv-' + A, plan, [
      'crear_reserva_whatsapp',
    ]);
  });

  it('sin plan reducido usa el prompt completo y todas las herramientas', async () => {
    const w = world(new Store(), () => 'ok');
    w.setTools(['a', 'b']);
    w.inbound(A, 'hola');
    await settle(DELAY_MS + 2_000);
    expect(w.slimPrompts).toHaveLength(0);
    expect(w.afterSlimTurn).not.toHaveBeenCalled();
    const tools = (
      w.aiInputs[0] as unknown as { tools: Array<{ name: string }> }
    ).tools;
    expect(tools).toHaveLength(2);
  });
});

describe('Reinicio por inactividad de la clienta', () => {
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

  it('si la clienta tardó más del tiempo del bot en contestar, se empieza de cero desde el último mensaje del bot', async () => {
    const store = new Store();
    const last = minutesAgo(90);
    store.lastOutboundValue = { content: '¿Confirmas?', at: last };
    const w = world(store, () => 'ok');
    w.inbound(A, 'quiero información de los servicios');
    await settle(DELAY_MS + 2_000);
    expect(store.resets).toHaveLength(1);
    expect(store.resets[0].since).toEqual(last);
    const turn = w.intentHandle.mock.calls[0][0] as { lastBotMessage: unknown };
    expect(turn.lastBotMessage).toBeNull();
  });

  it('dentro del tiempo no se reinicia', async () => {
    const store = new Store();
    store.lastOutboundValue = { content: '¿Confirmas?', at: minutesAgo(10) };
    const w = world(store, () => 'ok');
    w.inbound(A, 'quiero información de los servicios');
    await settle(DELAY_MS + 2_000);
    expect(store.resets).toHaveLength(0);
    const turn = w.intentHandle.mock.calls[0][0] as { lastBotMessage: unknown };
    expect(turn.lastBotMessage).not.toBeNull();
  });

  it('no se reinicia dos veces por el mismo mensaje del bot', async () => {
    const store = new Store();
    store.lastOutboundValue = { content: 'Hola', at: minutesAgo(120) };
    const w = world(store, () => '');
    w.inbound(A, 'quiero información uno');
    await settle(DELAY_MS + 2_000);
    w.inbound(A, 'quiero información dos');
    await settle(DELAY_MS + 2_000);
    expect(store.resets).toHaveLength(1);
  });

  it('los mensajes pendientes llegan al despachador con sus ids', async () => {
    const w = world(new Store(), () => 'ok');
    w.inbound(A, 'quiero información de los servicios');
    await settle(DELAY_MS + 2_000);
    const turn = w.intentHandle.mock.calls[0][0] as { pendingIds: string[] };
    expect(turn.pendingIds).toHaveLength(1);
  });

  const plan = {
    intentKey: 'booking',
    prompt: 'x',
    tools: [],
    via: 'flow',
    endsOnTools: ['crear_reserva_whatsapp'],
  };

  it('si la clienta confirmó y la IA no ejecutó la acción, reintenta una vez con la instrucción de ejecutarla', async () => {
    let call = 0;
    const w = world(new Store(), () => {
      call += 1;
      return call === 1
        ? { content: 'Listo, ya quedó agendada.', toolCallsExecuted: [] }
        : {
            content: 'Quedó creada tu cita.',
            toolCallsExecuted: [
              { name: 'crear_reserva_whatsapp', arguments: {}, ok: true },
            ],
          };
    });
    w.intentHandle.mockImplementationOnce(() =>
      Promise.resolve({
        handled: false,
        slim: { ...plan, hint: 'La clienta confirmó.' },
      } as never),
    );
    w.inbound(A, 'sí, confírmala');
    await settle(DELAY_MS + 2_000);

    expect(w.aiCalls).toHaveLength(2);
    expect(w.sends.map((s) => s.content)).toEqual(['Quedó creada tu cita.']);
    expect(w.metrics.snapshot().confirmWithoutAction).toBe(1);
    expect(w.afterSlimTurn).toHaveBeenCalledWith(
      'conv-' + A,
      expect.anything(),
      ['crear_reserva_whatsapp'],
    );
  });

  it('si ya la ejecutó, no reintenta', async () => {
    const w = world(new Store(), () => ({
      content: 'Quedó creada tu cita.',
      toolCallsExecuted: [
        { name: 'crear_reserva_whatsapp', arguments: {}, ok: true },
      ],
    }));
    w.intentHandle.mockImplementationOnce(() =>
      Promise.resolve({
        handled: false,
        slim: { ...plan, hint: 'La clienta confirmó.' },
      } as never),
    );
    w.inbound(A, 'sí, confírmala');
    await settle(DELAY_MS + 2_000);
    expect(w.aiCalls).toHaveLength(1);
  });
});
