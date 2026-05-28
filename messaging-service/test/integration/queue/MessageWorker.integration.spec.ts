jest.mock('@whiskeysockets/baileys', () => ({
  default: jest.fn().mockReturnValue({
    ev: { on: jest.fn() },
    sendMessage: jest.fn().mockResolvedValue({ key: { id: 'mock-msg-id' } }),
    logout: jest.fn(),
  }),
  useMultiFileAuthState: jest.fn().mockResolvedValue({
    state: {},
    saveCreds: jest.fn(),
  }),
  DisconnectReason: { loggedOut: 401 },
}));

jest.mock('qrcode-terminal', () => ({ generate: jest.fn() }));

import { Test, TestingModule } from '@nestjs/testing';
import { BullModule } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { getQueueToken } from '@nestjs/bullmq';
import { QUEUE_NAMES, MessageJobPayload } from 'src/queue/queues';
import { MessageWorker } from 'src/queue/BullMQ/workers/MessageWorker';
import { DLQHandler } from 'src/queue/Orchestrator/deadletter/DLQHandler';
import { ConfigService } from '@nestjs/config';
import { TEST_REDIS, clearQueue, waitForJob } from '../../helpers/redis.helper';
import { cleanDatabase, prisma } from '../../helpers/prisma.helper';
import { MessageStatus } from '@prisma/client';
import { ChannelPluginFactory } from 'src/channels/factories/ChannelPluginFactory';
import { TemplateService } from 'src/core/templates/TemplateService';
import { TemplateEngine } from 'src/core/templates/TemplateEngine';
import { PrismaService } from 'src/shared/prisma.service';

jest.setTimeout(30000);

describe('messageWorker - integration', () => {
  let module: TestingModule;
  let queue: Queue<MessageJobPayload>;

  const mockChannelFactory = {
    getPlugin: jest.fn().mockReturnValue({
      send: jest.fn().mockResolvedValue({
        success: true,
        provider: 'mock',
        providerMessageId: 'ext-123',
      }),
      validateRecipient: jest.fn().mockReturnValue(true),
    }),
  };

  const mockTemplateEngine = {
    render: jest.fn().mockReturnValue({
      subject: 'Asunto renderizado',
      body: '<h1>Cuerpo renderizado</h1>',
    }),
  };

  const mockTemplateService = {
    findOne: jest.fn().mockResolvedValue({
      id: 'tmpl-123',
      bodyHandlebars: '<h1>Hola {{nombre}}</h1>',
      subject: 'Hola {{nombre}}',
    }),
  };

  const mockPrisma = {
    message: {
      create: jest.fn(),
      update: jest.fn(),
      findUnique: jest.fn(),
    },
    messageAttempt: {
      create: jest.fn(),
    },
  };

  const mockDLQHandler = {
    handle: jest.fn().mockResolvedValue(undefined),
  };

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        BullModule.forRoot({ connection: TEST_REDIS }),
        BullModule.registerQueue(
          { name: QUEUE_NAMES.MESSAGES },
          { name: QUEUE_NAMES.DEAD_LETTER },
        ),
      ],
      providers: [
        MessageWorker,
        {
          provide: PrismaService,
          useValue: prisma,
        },
        { provide: ChannelPluginFactory, useValue: mockChannelFactory },
        { provide: TemplateEngine, useValue: mockTemplateEngine },
        { provide: TemplateService, useValue: mockTemplateService },
        { provide: DLQHandler, useValue: mockDLQHandler },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => {
              const values: Record<string, unknown> = {
                'redis.host': 'localhost',
                'redis.port': 6380,
                'queue.maxAttempts': 3,
              };
              return values[key];
            },
          },
        },
      ],
    }).compile();

    queue = module.get<Queue>(getQueueToken(QUEUE_NAMES.MESSAGES));
    await module.init();
  });

  afterAll(async () => {
    await module.close();
    await clearQueue(QUEUE_NAMES.MESSAGES);
    await clearQueue(QUEUE_NAMES.DEAD_LETTER);
  });

  beforeEach(async () => {
    await cleanDatabase();
    await clearQueue(QUEUE_NAMES.MESSAGES);
    jest.clearAllMocks();
  });

  it('deberia pasar un job exitosamente y actualizarse en al DB', async () => {
    const message = await prisma.message.create({
      data: {
        tenantId: 'default',
        channel: 'EMAIL',
        recipient: 'test@gmail.com',
        variables: {},
        status: MessageStatus.PENDING,
        scheduledAt: new Date(),
        maxAttempts: 3,
        renderedSubject: 'Test Subject',
      },
    });

    await queue.add('message.Email', {
      messageId: message.id,
      tenantId: 'default',
      channel: 'EMAIL',
      recipient: 'test@gmail.com',
      templateId: 'tmpl-123',
      variables: { nombre: 'Juan' },
      inlineBody: '<h1>Cuerpo renderizado</h1>',
      inlineSubject: 'Asunto renderizado',
    } as MessageJobPayload);

    const result = await waitForJob(QUEUE_NAMES.MESSAGES);
    expect(result.success).toBe(true);

    const updated = await prisma.message.findUnique({
      where: { id: message.id },
    });

    expect(updated?.status).toBe(MessageStatus.SENT);
    expect(updated?.sentAt).not.toBeNull();
    expect(updated?.provider).toBe('mock');
  });

  it('deberia mover a DLQ cuando devuelve error', async () => {
    // hacer una fallo a proposito
    mockChannelFactory.getPlugin.mockReturnValue({
      send: jest.fn().mockResolvedValue({
        success: false,
        provider: 'mock',
        retryable: false,
        errorCode: 'INVALID_RECIPIENT',
        error: 'Numero invalido',
      }),
    });

    // se crea el mensaje con el fallo
    const message = await prisma.message.create({
      data: {
        tenantId: 'default',
        channel: 'WHATSAPP',
        recipient: 'numero invalid',
        variables: {},
        status: MessageStatus.PENDING,
        scheduledAt: new Date(),
        maxAttempts: 3,
        renderedSubject: 'Test Subject',
      },
    });

    //lo enviamos a la cola para ver que responde
    await queue.add('message.WHATSAPP', {
      messageId: message.id,
      tenantId: 'default',
      channel: 'WHATSAPP',
      recipient: 'numero-invalido',
      templateId: 'tmpl-123',
      inlineBody: '<p>Hola {{nombre}}</p>',
      inlineSubject: 'Test Subject',
      variables: { nombre: 'Test' },
    } as MessageJobPayload);

    // esperamos el mensaje que no manda el Job y esperamos un fallo aqui
    await waitForJob(QUEUE_NAMES.MESSAGES);

    // deberia soltar un error
    expect(mockDLQHandler.handle).toHaveBeenCalledWith(
      message.id,
      expect.any(String),
      'INVALID_RECIPIENT',
    );

    //ademas deberia cmabiar el estado en prisma del mensaje a DEAD ya que paso por el DLQ
    const updated = await prisma.message.findUnique({
      where: { id: message.id },
    });
    expect(updated?.status).toBe(MessageStatus.DEAD);
  });

  it('deberia reintentar cuando el canal devuelve un error transitorio', async () => {
    //se crea variable de callCOunt para documentar cuantos intentos se realizan antes de succes
    let callCount = 0;

    // se hace el mock para probar encolado
    mockChannelFactory.getPlugin.mockReturnValue({
      send: jest.fn().mockImplementation(() => {
        callCount++;
        // se dice que hasta que llegue a 3 intentos nos devuelba true
        if (callCount < 3) {
          return Promise.resolve({
            success: false,
            provider: 'mock',
            retryable: true,
            errorCode: 'NETWORK_ERROR',
            error: 'Red caída temporalmente',
          });
        }
        return Promise.resolve({
          success: true,
          provider: 'mock',
          providerMessageId: 'ext-ok',
        });
      }),
      validateRecipient: jest.fn().mockReturnValue(true),
    });

    // despues se crea el mensaje en db solo se debe ver uno en db y es el que este en proceso
    const message = await prisma.message.create({
      data: {
        tenantId: 'default',
        channel: 'EMAIL',
        recipient: 'test@gmail.com',
        variables: {},
        status: MessageStatus.PENDING,
        scheduledAt: new Date(),
        maxAttempts: 3,
        renderedSubject: 'Test Subject',
      },
    });

    // se agrega a cola en espera de respuesta y aprovacion
    await queue.add(
      'message.EMAIL',
      {
        messageId: message.id,
        tenantId: 'default',
        channel: 'EMAIL',
        recipient: 'test@gmail.com',
        inlineBody: '<p>Test</p>',
        variables: {},
      } as MessageJobPayload,
      {
        attempts: 3,
        backoff: {
          type: 'fixed',
          delay: 100,
        },
      },
    );

    // se espera resultado si falla tarda 20000 ms en reencolarse y volver a reintentarse
    const result = await waitForJob(QUEUE_NAMES.MESSAGES, 10000);
    // como resultado se espera un succes: true
    expect(result.success).toBe(true);

    // se espera ver 3 intentos en el callCount
    expect(callCount).toBe(3);

    // despues de el proceso se actualiza estado en db se espera estado de SENT
    const updated = await prisma.message.findUnique({
      where: { id: message.id },
    });
    expect(updated?.status).toBe(MessageStatus.SENT);
  });
});
