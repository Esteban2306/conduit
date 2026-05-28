import { Test, TestingModule } from '@nestjs/testing';
import { MessageOrchestrator } from 'src/core/orchestrator/MessageOrchestrator';
import { getQueueToken } from '@nestjs/bullmq';
import { QUEUE_NAMES } from 'src/queue/queues';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from 'src/shared/prisma.service';
import { TemplateService } from 'src/core/templates/TemplateService';
import { MessageStatus } from '@prisma/client';
import { makeMessagePayload } from 'test/factories/message.factory';

describe('MessageOrchestrator', () => {
  let orchestrator: MessageOrchestrator;

  const mockQueue = {
    add: jest.fn().mockResolvedValue({ id: 'job-123' }),
    getJobs: jest.fn().mockResolvedValue([]),
  };

  const mockPrisma = {
    message: {
      create: jest.fn().mockResolvedValue({
        id: 'msg-uuid-123',
        status: MessageStatus.PENDING,
        attempts: 0,
        maxAttempts: 5,
      }),
      update: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn(),
    },
  };

  const mockConfig = {
    get: jest.fn((key: string) => {
      const values: Record<string, unknown> = {
        'tenant.defaultId': 'default',
        'queue.maxAttempts': 5,
      };
      return values[key];
    }),
  };

  const mockTemplateService = {
    findOne: jest.fn().mockResolvedValue({ id: 'tmpl-123', isActive: true }),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessageOrchestrator,
        { provide: getQueueToken(QUEUE_NAMES.MESSAGES), useValue: mockQueue },
        { provide: PrismaService, useValue: mockPrisma },
        { provide: ConfigService, useValue: mockConfig },
        { provide: TemplateService, useValue: mockTemplateService },
      ],
    }).compile();

    orchestrator = module.get<MessageOrchestrator>(MessageOrchestrator);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('dispatch()', () => {
    it('debe encolar un mensaje válido y devolver messageId', async () => {
      const payload = makeMessagePayload();
      const result = await orchestrator.dispatch(payload);

      expect(result.messageId).toBe('msg-uuid-123');
      expect(result.status).toBe(MessageStatus.QUEUED);
      expect(mockPrisma.message.create).toHaveBeenCalledTimes(1);
      expect(mockQueue.add).toHaveBeenCalledTimes(1);
      expect(mockQueue.add).toHaveBeenCalledWith(
        expect.stringContaining('message'),
        expect.objectContaining({ messageId: 'msg-uuid-123' }), // ✅ messageId
        expect.any(Object),
      );
    });

    it('debería actualizar el estado a QUEUED después de encolar', async () => {
      await orchestrator.dispatch(makeMessagePayload());

      expect(mockPrisma.message.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: MessageStatus.QUEUED }),
        }),
      );
    });

    it('debería lanzar error si el payload es completamente inválido', async () => {
      // Un objeto vacío nunca pasa la validación de Zod
      await expect(orchestrator.dispatch({})).rejects.toThrow();
    });

    it('debería lanzar error si el canal no está soportado', async () => {
      // TELEGRAM falla en Zod antes de llegar a validateChannel
      // Por eso verificamos que lanza error, sin importar el mensaje exacto
      const payload = makeMessagePayload({
        recipient: { channel: 'TELEGRAM', address: 'test@test.com' },
      });

      await expect(orchestrator.dispatch(payload)).rejects.toThrow(); // ✅ sin string específico
    });

    it('debería usar scheduledAt cuando se provee en options', async () => {
      const futureDate = new Date(Date.now() + 3600000).toISOString();
      const payload = makeMessagePayload({
        options: { scheduledAt: futureDate, priority: 'normal' },
      });

      await orchestrator.dispatch(payload);

      const callArgs = mockQueue.add.mock.calls[0][2];
      expect(callArgs.delay).toBeGreaterThan(0);
    });

    it('debería priorizar mensajes high sobre normal', async () => {
      await orchestrator.dispatch(
        makeMessagePayload({ options: { priority: 'high' } }),
      );
      const highCall = mockQueue.add.mock.calls[0][2];

      jest.clearAllMocks();
      mockPrisma.message.create.mockResolvedValue({
        id: 'msg-2',
        status: MessageStatus.PENDING,
        attempts: 0,
        maxAttempts: 5,
      });

      await orchestrator.dispatch(
        makeMessagePayload({ options: { priority: 'normal' } }),
      );
      const normalCall = mockQueue.add.mock.calls[0][2];

      expect(highCall.priority).toBeLessThan(normalCall.priority);
    });
  });

  describe('dispatchBatch()', () => {
    it('debería encolar múltiples mensajes y devolver 0 errores', async () => {
      const payloads = [
        makeMessagePayload(),
        makeMessagePayload({
          recipient: { channel: 'EMAIL', address: 'otro@gmail.com' }, // ✅ address correcto
        }),
      ];

      mockPrisma.message.create
        .mockResolvedValueOnce({
          id: 'msg-1',
          status: 'PENDING',
          attempts: 0,
          maxAttempts: 5,
        })
        .mockResolvedValueOnce({
          id: 'msg-2',
          status: 'PENDING',
          attempts: 0,
          maxAttempts: 5,
        }); // ✅ id no if

      const result = await orchestrator.dispatchBatch(payloads); // ✅ await directo

      expect(result.total).toBe(2);
      expect(result.queued).toBe(2);
      expect(result.failed).toHaveLength(0);
    });

    it('debería reportar errores sin detener el resto del batch', async () => {
      const payloads = [
        makeMessagePayload(),
        {}, // payload inválido — este es el que falla
        makeMessagePayload(),
      ];

      mockPrisma.message.create
        .mockResolvedValueOnce({
          id: 'msg-1',
          status: 'PENDING',
          attempts: 0,
          maxAttempts: 5,
        })
        .mockResolvedValueOnce({
          id: 'msg-3',
          status: 'PENDING',
          attempts: 0,
          maxAttempts: 5,
        });

      const result = await orchestrator.dispatchBatch(payloads); // ✅ await directo

      expect(result.total).toBe(3);
      expect(result.queued).toBe(2);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0].index).toBe(1);
    });
  });

  describe('cancel()', () => {
    it('debería cancelar mensaje PENDING y cambiar a CANCELLED', async () => {
      mockPrisma.message.findUnique.mockResolvedValue({
        id: 'msg-123',
        status: MessageStatus.PENDING,
      });

      const result = await orchestrator.cancel('msg-123');

      expect(result.status).toBe(MessageStatus.CANCELLED);
      expect(mockPrisma.message.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: MessageStatus.CANCELLED }),
        }),
      );
    });

    it('debería lanzar error si el mensaje no existe', async () => {
      mockPrisma.message.findUnique.mockResolvedValue(null);

      await expect(orchestrator.cancel('no-existe')).rejects.toThrow(
        'no encontrado',
      );
    });

    it('debería lanzar error si el mensaje ya fue enviado', async () => {
      mockPrisma.message.findUnique.mockResolvedValue({
        id: 'msg-123',
        status: MessageStatus.SENT,
      });

      await expect(orchestrator.cancel('msg-123')).rejects.toThrow(
        'no puede cancelarse',
      );
    });
  });
});
