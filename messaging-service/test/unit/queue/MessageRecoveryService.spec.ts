import { MessageStatus } from '@prisma/client';
import { MessageRecoveryService } from 'src/queue/recovery/MessageRecoveryService';

const old = new Date(Date.now() - 60 * 60 * 1000);

function stale(status: MessageStatus, overrides: Record<string, unknown> = {}) {
  return {
    id: 'm1',
    tenantId: 't1',
    channel: 'WHATSAPP',
    recipient: '573001234567',
    connectionId: 'c1',
    templateId: 'tpl',
    variables: {},
    meta: null,
    renderedBody: '',
    renderedSubject: '',
    status,
    sentAt: null,
    lastError: null,
    scheduledAt: old,
    updatedAt: old,
    ...overrides,
  };
}

describe('MessageRecoveryService', () => {
  const prisma = {
    message: { findMany: jest.fn(), update: jest.fn() },
  };
  const messageQueue = { getJob: jest.fn(), add: jest.fn() };
  const scheduledQueue = { getJob: jest.fn() };
  const jobSigner = { sign: jest.fn((p: object) => p) };
  const dlq = { handle: jest.fn() };
  const webhooks = { dispatch: jest.fn() };

  const service = new MessageRecoveryService(
    prisma as any,
    messageQueue as any,
    scheduledQueue as any,
    jobSigner as any,
    dlq as any,
    webhooks as any,
  );

  const withJob = (state: string, extra: Record<string, unknown> = {}) =>
    messageQueue.getJob.mockResolvedValue({
      getState: jest.fn().mockResolvedValue(state),
      ...extra,
    });

  beforeEach(() => {
    jest.clearAllMocks();
    messageQueue.getJob.mockResolvedValue(undefined);
    scheduledQueue.getJob.mockResolvedValue(undefined);
  });

  it.each([
    MessageStatus.PENDING,
    MessageStatus.QUEUED,
    MessageStatus.RETRYING,
  ])('re-encola un mensaje %s sin job (no salió)', async (status) => {
    prisma.message.findMany.mockResolvedValue([stale(status)]);

    await expect(service.sweep()).resolves.toBe(1);

    expect(messageQueue.add).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ messageId: 'm1' }),
      { jobId: 'msg-m1' },
    );
    expect(dlq.handle).not.toHaveBeenCalled();
  });

  it('NO reenvía un PROCESSING sin job: resultado incierto → DLQ', async () => {
    prisma.message.findMany.mockResolvedValue([
      stale(MessageStatus.PROCESSING),
    ]);

    await service.sweep();

    expect(messageQueue.add).not.toHaveBeenCalled();
    expect(dlq.handle).toHaveBeenCalledWith(
      'm1',
      expect.any(String),
      'UNKNOWN_OUTCOME',
    );
  });

  it.each(['active', 'delayed', 'waiting'])(
    'no toca un mensaje cuyo job sigue %s',
    async (state) => {
      prisma.message.findMany.mockResolvedValue([
        stale(MessageStatus.PROCESSING),
      ]);
      withJob(state);

      await expect(service.sweep()).resolves.toBe(0);
      expect(messageQueue.add).not.toHaveBeenCalled();
      expect(dlq.handle).not.toHaveBeenCalled();
    },
  );

  it('manda a DLQ un job agotado', async () => {
    prisma.message.findMany.mockResolvedValue([stale(MessageStatus.RETRYING)]);
    withJob('failed', { failedReason: 'WhatsApp no conectado' });

    await service.sweep();

    expect(dlq.handle).toHaveBeenCalledWith(
      'm1',
      'WhatsApp no conectado',
      'MAX_ATTEMPTS_EXCEEDED',
    );
  });

  it('job completado con sentAt: corrige a SENT y avisa sin reenviar', async () => {
    prisma.message.findMany.mockResolvedValue([
      stale(MessageStatus.QUEUED, { sentAt: old }),
    ]);
    withJob('completed');

    await service.sweep();

    expect(prisma.message.update).toHaveBeenCalledWith({
      where: { id: 'm1' },
      data: { status: MessageStatus.SENT },
    });
    expect(webhooks.dispatch).toHaveBeenCalledWith('message.sent', 'm1');
    expect(messageQueue.add).not.toHaveBeenCalled();
  });
});
