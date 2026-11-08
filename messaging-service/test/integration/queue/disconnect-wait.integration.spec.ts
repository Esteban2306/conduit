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

import { Queue, Worker } from 'bullmq';
import { MessageStatus } from '@prisma/client';
import { MessageProcessor } from 'src/queue/processors/MessageProcessor';

const port = Number(process.env.TEST_REDIS_PORT ?? 0);
const isolated = port > 0 && port !== 6379;
const suite = isolated ? describe : describe.skip;

suite('espera por desconexión con Redis real y aislado', () => {
  const connection = {
    host: '127.0.0.1',
    port,
    password: process.env.TEST_REDIS_PASSWORD || undefined,
  };
  const queueName = `phase25-${Date.now()}`;
  let queue: Queue;
  let worker: Worker;

  let connected = false;
  let optedOut = false;
  let sendResult: { success: boolean; errorCode?: string; retryable?: boolean };
  let waitMs = 60_000;
  let scheduledAt = new Date();
  let category: string | null = 'MARKETING';

  const send = jest.fn();
  const messageUpdates: Array<Record<string, any>> = [];
  const dlq = { handle: jest.fn().mockResolvedValue(undefined) };
  const webhooks = { dispatch: jest.fn().mockResolvedValue(undefined) };

  const prisma = {
    message: {
      findUnique: jest.fn(() =>
        Promise.resolve({
          id: 'm1',
          tenantId: 't1',
          connectionId: 'c1',
          status: MessageStatus.QUEUED,
          category,
          scheduledAt,
          updatedAt: new Date(),
          lastError: null,
        }),
      ),
      update: jest.fn(({ data }) => {
        messageUpdates.push(data);
        return Promise.resolve({});
      }),
    },
    whatsAppConnection: {
      findFirst: jest.fn().mockResolvedValue({ id: 'c1' }),
    },
    messageAttempt: { create: jest.fn().mockResolvedValue({}) },
  };

  const plugin = {
    isAvailable: () => connected,
    send: (...args: unknown[]) => {
      send(...args);
      return Promise.resolve({
        provider: 'baileys',
        providerMessageId: 'wa1',
        raw: {},
        ...sendResult,
      });
    },
  };

  const processor = new MessageProcessor(
    {
      get: (key: string) =>
        ({
          'queue.disconnectWaitMs': waitMs,
          'queue.disconnectPollMs': 150,
        })[key],
    } as never,
    prisma as never,
    { getPlugin: () => plugin } as never,
    {} as never,
    { render: (body: string) => ({ subject: '', body }) } as never,
    dlq as never,
    webhooks as never,
    { verify: () => ({ valid: true }) } as never,
    { publish: jest.fn() } as never,
    { isOptedOutForTenant: () => Promise.resolve(optedOut) } as never,
  );

  const until = async (check: () => boolean | Promise<boolean>, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 40));
    }
    throw new Error('timeout esperando la condición');
  };

  const enqueue = () =>
    queue.add('m', {
      messageId: 'm1',
      tenantId: 't1',
      channel: 'WHATSAPP',
      recipient: '573001112233',
      connectionId: 'c1',
      templateId: '',
      inlineBody: 'hola',
      inlineSubject: '',
      variables: {},
      _signature: 's',
      _signedAt: Date.now(),
      _expiresAt: Date.now() + 1e9,
    });

  beforeAll(async () => {
    queue = new Queue(queueName, {
      connection,
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 120_000 },
      },
    });
    worker = new Worker(
      queueName,
      (job, token) => processor.process(job as never, token),
      {
        connection,
        concurrency: 2,
      },
    );
    await worker.waitUntilReady();
  });

  afterAll(async () => {
    await worker.close();
    await queue.obliterate({ force: true });
    await queue.close();
  });

  beforeEach(async () => {
    connected = false;
    optedOut = false;
    waitMs = 60_000;
    scheduledAt = new Date();
    category = 'MARKETING';
    sendResult = { success: true };
    send.mockClear();
    messageUpdates.length = 0;
    dlq.handle.mockClear();
    webhooks.dispatch.mockClear();
    await queue.obliterate({ force: true });
  });

  it('con la línea caída no gasta intentos ni envía, y al reconectar envía una sola vez', async () => {
    const job = await enqueue();
    await new Promise((r) => setTimeout(r, 1500));

    const waiting = await queue.getJob(job.id as string);
    expect(await waiting!.getState()).toBe('delayed');
    expect(waiting!.attemptsMade).toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect(messageUpdates.some((d) => 'attempts' in d)).toBe(false);
    expect(messageUpdates[0]).toMatchObject({ status: MessageStatus.RETRYING });

    connected = true;
    await until(async () => (await waiting!.getState()) === 'completed');

    expect(send).toHaveBeenCalledTimes(1);
    expect(messageUpdates.some((d) => d.status === MessageStatus.SENT)).toBe(
      true,
    );
    expect(webhooks.dispatch).toHaveBeenCalledWith('message.sent', 'm1');
    expect(dlq.handle).not.toHaveBeenCalled();
  });

  it('pasado el tope de espera lo manda a la DLQ en vez de seguir esperando', async () => {
    waitMs = 1_000;
    scheduledAt = new Date(Date.now() - 60_000);
    const job = await enqueue();
    await until(() => dlq.handle.mock.calls.length > 0);

    expect(dlq.handle).toHaveBeenCalledWith(
      'm1',
      expect.stringContaining('desconectada'),
      'WHATSAPP_DISCONNECT_TIMEOUT',
    );
    expect(send).not.toHaveBeenCalled();
    await until(
      async () =>
        (await (await queue.getJob(job.id as string))!.getState()) ===
        'completed',
    );
  });

  it('si la clienta se da de baja mientras espera, se cancela y no se envía', async () => {
    const job = await enqueue();
    await new Promise((r) => setTimeout(r, 500));
    optedOut = true;
    connected = true;
    await until(() =>
      messageUpdates.some((d) => d.status === MessageStatus.CANCELLED),
    );

    expect(send).not.toHaveBeenCalled();
    expect(webhooks.dispatch).toHaveBeenCalledWith('message.cancelled', 'm1');
    await until(
      async () =>
        (await (await queue.getJob(job.id as string))!.getState()) ===
        'completed',
    );
  });

  it('un mensaje que no es de marketing no consulta las bajas', async () => {
    category = 'TRANSACTIONAL';
    optedOut = true;
    connected = true;
    await enqueue();
    await until(() => send.mock.calls.length > 0);
    expect(
      messageUpdates.some((d) => d.status === MessageStatus.CANCELLED),
    ).toBe(false);
  });

  it('si la línea cae justo al enviar (carrera) también espera sin gastar el intento', async () => {
    connected = true;
    sendResult = {
      success: false,
      errorCode: 'WHATSAPP_NOT_CONNECTED',
      retryable: true,
    };
    const job = await enqueue();
    await until(() => send.mock.calls.length >= 1);
    await new Promise((r) => setTimeout(r, 400));

    const current = await queue.getJob(job.id as string);
    expect(['delayed', 'active', 'waiting']).toContain(
      await current!.getState(),
    );
    expect(current!.attemptsMade).toBe(0);

    sendResult = { success: true };
    await until(async () => (await current!.getState()) === 'completed');
  });
});
