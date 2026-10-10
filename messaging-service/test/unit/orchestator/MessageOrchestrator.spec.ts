import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { MessageStatus, Prisma } from '@prisma/client';
import { MessageOrchestrator } from 'src/core/orchestrator/MessageOrchestrator';
import { QUEUE_NAMES } from 'src/queue/queues';
import { PrismaService } from 'src/shared/prisma.service';
import { TemplateService } from 'src/core/templates/TemplateService';
import { JobSigner } from 'src/queue/security/JobSigner';
import { FileParserService } from 'src/core/adapters/FileParserService';
import { WebhookDispatcher } from 'src/webhooks/WebhookDispatcher';
import { WhatsAppContactService } from 'src/channels/whatsapp/contacts/WhatsAppContactService';
import {
  makeMessagePayload,
  makeWhatsAppPayload,
} from 'test/factories/message.factory';

const TENANT = 'tenant-1';
const CONNECTION_ID = 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e';

function messageRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg-uuid-123',
    tenantId: TENANT,
    channel: 'EMAIL',
    recipient: 'test@gmail.com',
    connectionId: null,
    templateId: null,
    variables: {},
    meta: null,
    renderedBody: '<h1>Hola</h1>',
    renderedSubject: 'Test',
    status: MessageStatus.PENDING,
    attempts: 0,
    maxAttempts: 5,
    scheduledAt: new Date(),
    ...overrides,
  };
}

describe('MessageOrchestrator', () => {
  let orchestrator: MessageOrchestrator;

  const mockQueue = {
    add: jest.fn().mockResolvedValue({ id: 'job-123' }),
    getJob: jest.fn().mockResolvedValue(undefined),
  };
  const mockScheduledQueue = {
    add: jest.fn().mockResolvedValue({ id: 'job-s-123' }),
    getJob: jest.fn().mockResolvedValue(undefined),
  };

  const mockPrisma = {
    message: {
      create: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn(),
    },
    whatsAppConnection: {
      findFirst: jest.fn().mockResolvedValue({ id: CONNECTION_ID }),
    },
  };

  const mockConfig = {
    get: jest.fn((key: string) =>
      key === 'queue.maxAttempts' ? 5 : undefined,
    ),
  };

  const mockTemplateService = {
    findOne: jest.fn().mockResolvedValue({ id: 'tmpl-123', isActive: true }),
  };
  const mockJobSigner = {
    sign: jest.fn((payload: object) => ({ ...payload, _signature: 'sig' })),
  };
  const mockWebhookDispatcher = { dispatch: jest.fn() };
  const mockContacts = { campaignGate: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPrisma.message.create.mockResolvedValue(messageRow());
    mockPrisma.message.findUnique.mockResolvedValue(null);
    mockPrisma.message.updateMany.mockResolvedValue({ count: 1 });
    mockContacts.campaignGate.mockResolvedValue({ allowed: true });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessageOrchestrator,
        { provide: getQueueToken(QUEUE_NAMES.MESSAGES), useValue: mockQueue },
        {
          provide: getQueueToken(QUEUE_NAMES.MESSAGES_SCHEDULED),
          useValue: mockScheduledQueue,
        },
        { provide: PrismaService, useValue: mockPrisma },
        { provide: ConfigService, useValue: mockConfig },
        { provide: TemplateService, useValue: mockTemplateService },
        { provide: JobSigner, useValue: mockJobSigner },
        { provide: FileParserService, useValue: {} },
        { provide: WebhookDispatcher, useValue: mockWebhookDispatcher },
        { provide: WhatsAppContactService, useValue: mockContacts },
      ],
    }).compile();

    orchestrator = module.get(MessageOrchestrator);
  });

  describe('dispatch()', () => {
    it('encola un mensaje válido con jobId determinista', async () => {
      const result = await orchestrator.dispatch(TENANT, makeMessagePayload());

      expect(result).toEqual({
        messageId: 'msg-uuid-123',
        status: MessageStatus.QUEUED,
        duplicate: false,
      });
      expect(mockQueue.add).toHaveBeenCalledWith(
        'message:EMAIL',
        expect.objectContaining({ messageId: 'msg-uuid-123' }),
        expect.objectContaining({ jobId: 'msg-msg-uuid-123' }),
      );
    });

    it('pasa a QUEUED solo si el mensaje sigue en PENDING', async () => {
      await orchestrator.dispatch(TENANT, makeMessagePayload());

      expect(mockPrisma.message.updateMany).toHaveBeenCalledWith({
        where: { id: 'msg-uuid-123', status: MessageStatus.PENDING },
        data: { status: MessageStatus.QUEUED },
      });
    });

    it('rechaza un payload completamente inválido', async () => {
      await expect(orchestrator.dispatch(TENANT, {})).rejects.toThrow();
    });

    it('rechaza un canal no soportado', async () => {
      const payload = makeMessagePayload({
        recipient: { channel: 'TELEGRAM', address: 'test@test.com' },
      });
      await expect(orchestrator.dispatch(TENANT, payload)).rejects.toThrow();
    });

    it('usa la cola programada y un delay cuando scheduledAt es futuro', async () => {
      const futureDate = new Date(Date.now() + 3600000).toISOString();
      await orchestrator.dispatch(
        TENANT,
        makeMessagePayload({
          options: { scheduledAt: futureDate, priority: 'normal' },
        }),
      );

      expect(mockQueue.add).not.toHaveBeenCalled();
      const options = mockScheduledQueue.add.mock.calls[0][2];
      expect(options.delay).toBeGreaterThan(0);
    });

    it('prioriza high sobre normal', async () => {
      await orchestrator.dispatch(
        TENANT,
        makeMessagePayload({ options: { priority: 'high' } }),
      );
      await orchestrator.dispatch(
        TENANT,
        makeMessagePayload({ options: { priority: 'normal' } }),
      );

      const [high, normal] = mockQueue.add.mock.calls.map((c) => c[2]);
      expect(high.priority).toBeLessThan(normal.priority);
    });
  });

  describe('dispatch() por WhatsApp', () => {
    it('normaliza "+57…" a dígitos antes de guardar', async () => {
      await orchestrator.dispatch(
        TENANT,
        makeWhatsAppPayload({
          recipient: { channel: 'WHATSAPP', address: '+57 300 123 4567' },
          connectionId: CONNECTION_ID,
        }),
      );

      expect(mockPrisma.message.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ recipient: '573001234567' }),
        }),
      );
    });

    it('rechaza con 400 un número sin código de país válido', async () => {
      await expect(
        orchestrator.dispatch(
          TENANT,
          makeWhatsAppPayload({
            recipient: { channel: 'WHATSAPP', address: 'no-es-numero' },
            connectionId: CONNECTION_ID,
          }),
        ),
      ).rejects.toThrow('no es un número de WhatsApp válido');
      expect(mockPrisma.message.create).not.toHaveBeenCalled();
    });
  });

  describe('política anti-bloqueo', () => {
    it('rechaza con 400 un número que nunca escribió (no crea el mensaje)', async () => {
      mockContacts.campaignGate.mockResolvedValue({
        allowed: false,
        reason: 'El número 573001234567 nunca le ha escrito a este WhatsApp',
      });

      await expect(
        orchestrator.dispatch(
          TENANT,
          makeWhatsAppPayload({ connectionId: CONNECTION_ID }),
        ),
      ).rejects.toThrow();
      expect(mockContacts.campaignGate).toHaveBeenCalledWith(
        CONNECTION_ID,
        '573001234567',
      );
      expect(mockPrisma.message.create).not.toHaveBeenCalled();
    });
  });

  describe('idempotencia', () => {
    const KEY = 'leonice:reminder:res-1';

    it('guarda la clave en el mensaje nuevo', async () => {
      await orchestrator.dispatch(TENANT, makeMessagePayload(), {
        idempotencyKey: KEY,
      });

      expect(mockPrisma.message.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ idempotencyKey: KEY }),
        }),
      );
    });

    it('devuelve el mensaje existente sin crear ni encolar otro', async () => {
      mockPrisma.message.findUnique.mockResolvedValue(
        messageRow({ status: MessageStatus.SENT }),
      );

      const result = await orchestrator.dispatch(TENANT, makeMessagePayload(), {
        idempotencyKey: KEY,
      });

      expect(result).toEqual({
        messageId: 'msg-uuid-123',
        status: MessageStatus.SENT,
        duplicate: true,
      });
      expect(mockPrisma.message.create).not.toHaveBeenCalled();
      expect(mockQueue.add).not.toHaveBeenCalled();
    });

    it('re-encola un existente que quedó en PENDING (Redis falló la primera vez)', async () => {
      mockPrisma.message.findUnique.mockResolvedValue(messageRow());

      const result = await orchestrator.dispatch(TENANT, makeMessagePayload(), {
        idempotencyKey: KEY,
      });

      expect(result.duplicate).toBe(true);
      expect(mockPrisma.message.create).not.toHaveBeenCalled();
      expect(mockQueue.add).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Object),
        expect.objectContaining({ jobId: 'msg-msg-uuid-123' }),
      );
    });

    it('resuelve la carrera de dos peticiones simultáneas (P2002)', async () => {
      mockPrisma.message.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(messageRow({ status: MessageStatus.QUEUED }));
      mockPrisma.message.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('unique', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );

      const result = await orchestrator.dispatch(TENANT, makeMessagePayload(), {
        idempotencyKey: KEY,
      });

      expect(result).toEqual(
        expect.objectContaining({ duplicate: true, status: 'QUEUED' }),
      );
      expect(mockQueue.add).not.toHaveBeenCalled();
    });

    it('rechaza claves con formato inválido', async () => {
      await expect(
        orchestrator.dispatch(TENANT, makeMessagePayload(), {
          idempotencyKey: 'corta',
        }),
      ).rejects.toThrow('Idempotency-Key inválida');
    });
  });

  describe('dispatchBatch()', () => {
    it('reporta errores sin detener el resto del batch', async () => {
      const result = await orchestrator.dispatchBatch(TENANT, [
        makeMessagePayload(),
        {},
        makeMessagePayload(),
      ]);

      expect(result.total).toBe(3);
      expect(result.queued).toBe(2);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0].index).toBe(1);
    });
  });

  describe('cancel()', () => {
    it('cancela un mensaje PENDING, quita su job y emite el webhook', async () => {
      const job = {
        isActive: jest.fn().mockResolvedValue(false),
        remove: jest.fn(),
      };
      mockQueue.getJob.mockResolvedValueOnce(job);
      mockPrisma.message.findUnique.mockResolvedValue(messageRow());

      const result = await orchestrator.cancel('msg-uuid-123', TENANT);

      expect(result.status).toBe(MessageStatus.CANCELLED);
      expect(job.remove).toHaveBeenCalled();
      expect(mockWebhookDispatcher.dispatch).toHaveBeenCalledWith(
        'message.cancelled',
        'msg-uuid-123',
      );
    });

    it('lanza error si el mensaje no existe', async () => {
      await expect(orchestrator.cancel('no-existe', TENANT)).rejects.toThrow(
        'no encontrado',
      );
    });

    it('lanza error si el mensaje ya fue enviado', async () => {
      mockPrisma.message.findUnique.mockResolvedValue(
        messageRow({ status: MessageStatus.SENT }),
      );
      await expect(orchestrator.cancel('msg-uuid-123', TENANT)).rejects.toThrow(
        'no puede cancelarse',
      );
    });

    it('no pisa el estado si el worker lo tomó mientras se cancelaba', async () => {
      mockPrisma.message.findUnique.mockResolvedValue(messageRow());
      mockPrisma.message.updateMany.mockResolvedValue({ count: 0 });

      await expect(orchestrator.cancel('msg-uuid-123', TENANT)).rejects.toThrow(
        'cambió de estado',
      );
      expect(mockWebhookDispatcher.dispatch).not.toHaveBeenCalled();
    });
  });
});
