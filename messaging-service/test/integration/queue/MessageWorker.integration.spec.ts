jest.mock('@whiskeysockets/baileys', () => ({
  __esModule: true,
  default: jest.fn(),
  DisconnectReason: { loggedOut: 401 },
}));

import { randomBytes, randomUUID } from 'crypto';
import { Queue, QueueEvents } from 'bullmq';
import { PrismaClient, MessageStatus } from '@prisma/client';
import { MessageWorker } from 'src/queue/BullMQ/workers/MessageWorker';
import { MessageProcessor } from 'src/queue/processors/MessageProcessor';
import { JobSigner } from 'src/queue/security/JobSigner';
import { QUEUE_NAMES, MessageJobPayload } from 'src/queue/queues';
import { isolatedInfra } from '../../helpers/isolated-env';
import { clearQueue, finished } from '../../helpers/redis.helper';
import {
  createTestPrisma,
  createTestTenant,
  deleteTestTenant,
} from '../../helpers/prisma.helper';

const infra = isolatedInfra();
const suite = infra ? describe : describe.skip;

jest.setTimeout(30000);

suite('MessageWorker con MessageProcessor real, Redis y base aislados', () => {
  const { redis, databaseUrl } = infra ?? {
    redis: { host: '', port: 0 },
    databaseUrl: '',
  };
  const tenantId = `it-${randomUUID()}`;
  const signingSecret = randomBytes(32).toString('hex');

  let prisma: PrismaClient;
  let queue: Queue;
  let events: QueueEvents;
  let worker: MessageWorker;

  const sentResults: Array<() => Record<string, unknown>> = [];
  const plugin = {
    send: jest.fn(() => Promise.resolve(sentResults.shift()?.())),
  };
  const dlq = { handle: jest.fn().mockResolvedValue(undefined) };
  const webhooks = { dispatch: jest.fn().mockResolvedValue(undefined) };

  const config = {
    get: (key: string) =>
      ({
        'redis.host': redis.host,
        'redis.port': redis.port,
        'redis.password': redis.password,
        'webhook.signingSecret': signingSecret,
        'queue.disconnectWaitMs': 0,
        'queue.disconnectPollMs': 100,
      })[key],
  };
  const signer = new JobSigner(config as never);

  const createMessage = (recipient: string) =>
    prisma.message.create({
      data: {
        tenantId,
        channel: 'EMAIL',
        recipient,
        variables: {},
        status: MessageStatus.PENDING,
        scheduledAt: new Date(),
        maxAttempts: 3,
        renderedSubject: 'Asunto',
      },
    });

  const payloadFor = (
    messageId: string,
    recipient: string,
  ): MessageJobPayload => ({
    messageId,
    tenantId,
    channel: 'EMAIL',
    recipient,
    connectionId: undefined,
    templateId: '',
    inlineBody: '<p>Hola</p>',
    inlineSubject: 'Asunto',
    variables: {},
  });

  const enqueue = async (
    data: unknown,
    messageId: string,
    attempts = 1,
  ): Promise<string> => {
    const job = await queue.add('message.EMAIL', data, {
      jobId: `msg-${messageId}`,
      attempts,
      backoff: { type: 'fixed', delay: 100 },
    });
    return job.id as string;
  };

  const message = (id: string) => prisma.message.findUnique({ where: { id } });

  beforeAll(async () => {
    prisma = createTestPrisma(databaseUrl);
    await createTestTenant(prisma, tenantId);
    await clearQueue(QUEUE_NAMES.MESSAGES, redis);

    queue = new Queue(QUEUE_NAMES.MESSAGES, { connection: redis });
    events = new QueueEvents(QUEUE_NAMES.MESSAGES, { connection: redis });
    await events.waitUntilReady();

    const processor = new MessageProcessor(
      config as never,
      prisma as never,
      { getPlugin: () => plugin } as never,
      {} as never,
      {
        render: (body: string, _v: unknown, subject?: string) => ({
          subject,
          body,
        }),
      } as never,
      dlq as never,
      webhooks as never,
      signer,
      { publish: jest.fn() } as never,
      {} as never,
    );
    worker = new MessageWorker(config as never, processor);
    worker.onModuleInit();
  });

  afterAll(async () => {
    await worker?.onModuleDestroy();
    await events?.close();
    await queue?.close();
    await clearQueue(QUEUE_NAMES.MESSAGES, redis);
    await deleteTestTenant(prisma, tenantId);
    await prisma.$disconnect();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    sentResults.length = 0;
  });

  it('marca el mensaje como enviado cuando el canal responde bien', async () => {
    const msg = await createMessage('ok@example.test');
    sentResults.push(() => ({
      success: true,
      provider: 'mock',
      providerMessageId: 'ext-ok',
    }));

    const jobId = await enqueue(
      signer.sign(payloadFor(msg.id, msg.recipient)),
      msg.id,
    );
    const result = await finished(events, queue, jobId);

    expect(result.success).toBe(true);
    const saved = await message(msg.id);
    expect(saved?.status).toBe(MessageStatus.SENT);
    expect(saved?.sentAt).not.toBeNull();
    expect(saved?.provider).toBe('mock');
    expect(webhooks.dispatch).toHaveBeenCalledWith('message.sent', msg.id);
  });

  it('manda a la DLQ y marca DEAD ante un error no reintentable', async () => {
    const msg = await createMessage('malo@example.test');
    sentResults.push(() => ({
      success: false,
      provider: 'mock',
      retryable: false,
      errorCode: 'INVALID_RECIPIENT',
      error: 'Destinatario inválido',
    }));

    const jobId = await enqueue(
      signer.sign(payloadFor(msg.id, msg.recipient)),
      msg.id,
    );
    await finished(events, queue, jobId);

    expect(dlq.handle).toHaveBeenCalledWith(
      msg.id,
      expect.any(String),
      'INVALID_RECIPIENT',
    );
    expect((await message(msg.id))?.status).toBe(MessageStatus.DEAD);
  });

  it('reintenta ante un error transitorio y termina enviando', async () => {
    const msg = await createMessage('retry@example.test');
    const transient = () => ({
      success: false,
      provider: 'mock',
      retryable: true,
      errorCode: 'NETWORK_ERROR',
      error: 'Red caída temporalmente',
    });
    sentResults.push(transient, transient, () => ({
      success: true,
      provider: 'mock',
      providerMessageId: 'ext-retry',
    }));

    const jobId = await enqueue(
      signer.sign(payloadFor(msg.id, msg.recipient)),
      msg.id,
      3,
    );
    const result = await finished(events, queue, jobId, 15000);

    expect(result.success).toBe(true);
    expect(plugin.send).toHaveBeenCalledTimes(3);
    expect((await message(msg.id))?.status).toBe(MessageStatus.SENT);
  });

  it('rechaza un job con la firma alterada sin enviar nada', async () => {
    const msg = await createMessage('firma@example.test');
    const signed = signer.sign(payloadFor(msg.id, msg.recipient));

    const jobId = await enqueue(
      { ...signed, recipient: 'otro@example.test' },
      msg.id,
    );
    await finished(events, queue, jobId);

    expect(plugin.send).not.toHaveBeenCalled();
    expect(dlq.handle).toHaveBeenCalledWith(
      msg.id,
      expect.any(String),
      'INVALID_JOB_SIGNATURE',
    );
  });
});
