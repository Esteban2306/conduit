import {
  ConversationService,
  replyPosition,
} from 'src/bot/conversation/ConversationService';
import { OutboundReplyService } from 'src/channels/whatsapp/outbox/OutboundReply.service';

type Row = {
  direction: string;
  content: string;
  createdAt: Date;
  processedBy: string;
};

const at = (s: string) => new Date(`2026-11-14T12:${s}Z`);

function conversationService(
  messages: Row[],
  queued: Array<{
    groupId: string;
    content: string;
    createdAt: Date;
    answeredUntil?: Date | null;
  }> = [],
) {
  const rows = messages.map((m, i) => ({
    id: `m${i}`,
    hasImage: false,
    waMessageId: null,
    ...m,
  }));
  const created: Array<Record<string, any>> = [];
  const prisma = {
    conversation: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'c1',
        context: { memoriaAcciones: [] },
        summary: null,
        currentStep: null,
        lastIntent: null,
      }),
      update: jest.fn().mockResolvedValue({}),
    },
    botMessage: {
      findMany: jest.fn().mockResolvedValue([...rows].reverse()),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn((args: { data: Record<string, any> }) => {
        created.push(args.data);
        return Promise.resolve({ id: 'new', ...args.data });
      }),
    },
    outboundReply: { findMany: jest.fn().mockResolvedValue(queued) },
    $transaction: jest.fn((ops: Array<Promise<unknown>>) => Promise.all(ops)),
  };
  const service = new ConversationService(
    prisma as any,
    {
      publish: jest.fn(),
    } as any,
  );
  return { service, prisma, created };
}

describe('replyPosition', () => {
  it('ubica la respuesta justo después del último mensaje que contesta', () => {
    expect(
      replyPosition({
        createdAt: at('00:09.000'),
        answeredUntil: at('00:00.000'),
      }),
    ).toEqual(at('00:00.001'));
  });

  it('sin ese dato usa la hora real', () => {
    expect(replyPosition({ createdAt: at('00:09.000') })).toEqual(
      at('00:09.000'),
    );
    expect(
      replyPosition({ createdAt: at('00:09.000'), answeredUntil: null }),
    ).toEqual(at('00:09.000'));
  });
});

describe('mensajes que llegan mientras el bot prepara o envía su respuesta', () => {
  it('la respuesta se guarda ubicada tras lo que contestó, no cuando salió', async () => {
    const { service, created } = conversationService([]);

    await service.saveOutbound('c1', 'Hola, ¿en qué te ayudo?', {
      answeredUntil: at('00:00.000'),
    });

    expect(created[0].createdAt).toEqual(at('00:00.001'));
  });

  it('sin `answeredUntil` la respuesta se guarda con la hora real, como antes', async () => {
    const { service, created } = conversationService([]);

    await service.saveOutbound('c1', 'Hola');

    expect(created[0]).not.toHaveProperty('createdAt');
  });

  it('un mensaje recibido mientras se generaba la respuesta sigue pendiente aunque la respuesta salga después', async () => {
    // 00:00 "hola" → el bot genera → 00:05 llega "quiero cita" → 00:09 sale la
    // respuesta, que solo contestó "hola" y por eso queda ubicada tras él.
    const { service } = conversationService([
      {
        direction: 'INBOUND',
        content: 'hola',
        createdAt: at('00:00.000'),
        processedBy: 'user',
      },
      {
        direction: 'OUTBOUND',
        content: 'Hola, ¿en qué te ayudo?',
        createdAt: at('00:00.001'),
        processedBy: 'bot',
      },
      {
        direction: 'INBOUND',
        content: 'quiero cita',
        createdAt: at('00:05.000'),
        processedBy: 'user',
      },
    ]);

    const data = await service.getConversationForAI('c1', 6);

    expect(data.pending.map((p) => p.content)).toEqual(['quiero cita']);
    expect(data.pending[0].createdAt).toEqual(at('00:05.000'));
    expect(data.history.map((h) => h.content)).toEqual([
      'hola',
      'Hola, ¿en qué te ayudo?',
    ]);
  });

  it('una respuesta en cola se ubica tras lo que contesta: lo que el cliente escribe mientras espera turno sigue pendiente', async () => {
    const { service } = conversationService(
      [
        {
          direction: 'INBOUND',
          content: 'hola',
          createdAt: at('00:00.000'),
          processedBy: 'user',
        },
        {
          direction: 'INBOUND',
          content: 'quiero cita',
          createdAt: at('00:05.000'),
          processedBy: 'user',
        },
      ],
      [
        {
          groupId: 'g1',
          content: 'Hola, ¿en qué te ayudo?',
          createdAt: at('00:08.000'),
          answeredUntil: at('00:00.000'),
        },
      ],
    );

    const data = await service.getConversationForAI('c1', 6);

    expect(data.pending.map((p) => p.content)).toEqual(['quiero cita']);
  });

  it('una respuesta en cola sin `answeredUntil` (anterior a este cambio) mantiene el comportamiento de siempre', async () => {
    const { service } = conversationService(
      [
        {
          direction: 'INBOUND',
          content: 'hola',
          createdAt: at('00:00.000'),
          processedBy: 'user',
        },
      ],
      [
        {
          groupId: 'g1',
          content: 'Hola',
          createdAt: at('00:08.000'),
          answeredUntil: null,
        },
      ],
    );

    const data = await service.getConversationForAI('c1', 6);

    expect(data.pending).toEqual([]);
  });
});

describe('ConversationService.hasNewInboundSince', () => {
  it('sin punto de comparación no hay nada nuevo', async () => {
    const { service, prisma } = conversationService([]);

    await expect(service.hasNewInboundSince('c1', null)).resolves.toBe(false);
    expect(prisma.botMessage.findFirst).not.toHaveBeenCalled();
  });

  it('busca mensajes del cliente posteriores que pidan respuesta, sin contar acuses ignorados', async () => {
    const { service, prisma } = conversationService([]);
    prisma.botMessage.findFirst.mockResolvedValue({ id: 'x' });

    await expect(
      service.hasNewInboundSince('c1', at('00:00.000')),
    ).resolves.toBe(true);

    expect(prisma.botMessage.findFirst).toHaveBeenCalledWith({
      where: {
        conversationId: 'c1',
        direction: 'INBOUND',
        createdAt: { gt: at('00:00.000') },
        processedBy: { notIn: ['ignored', 'expired_reply'] },
      },
      select: { id: true },
    });
  });

  it('sin mensajes posteriores responde que no', async () => {
    const { service } = conversationService([]);

    await expect(
      service.hasNewInboundSince('c1', at('00:00.000')),
    ).resolves.toBe(false);
  });
});

describe('OutboundReplyService.supersedeUnsent', () => {
  type OutRow = {
    id: string;
    groupId: string;
    supersedable: boolean;
    status: string;
    conversationId: string;
  };

  function outbox(rows: OutRow[]) {
    const prisma = {
      outboundReply: {
        findMany: jest.fn(
          (args: { where: Record<string, any>; select?: unknown }) => {
            const w = args.where;
            if (w.conversationId) {
              return Promise.resolve(
                rows.filter(
                  (r) =>
                    r.conversationId === w.conversationId &&
                    w.status.in.includes(r.status),
                ),
              );
            }
            return Promise.resolve(
              rows
                .filter(
                  (r) =>
                    w.groupId.in.includes(r.groupId) && r.status === w.status,
                )
                .map((r) => ({ groupId: r.groupId })),
            );
          },
        ),
        updateMany: jest.fn(
          (args: { where: { id: { in: string[] } }; data: any }) => {
            const hit = rows.filter((r) => args.where.id.in.includes(r.id));
            hit.forEach((r) => (r.status = args.data.status));
            return Promise.resolve({ count: hit.length });
          },
        ),
      },
    };
    return { service: new OutboundReplyService(prisma as any), prisma };
  }

  const row = (over: Partial<OutRow>): OutRow => ({
    id: 'r1',
    groupId: 'g1',
    supersedable: true,
    status: 'PENDING',
    conversationId: 'c1',
    ...over,
  });

  it('descarta las respuestas de la conversación que aún no salieron', async () => {
    const rows = [
      row({ id: 'r1', groupId: 'g1' }),
      row({ id: 'r2', groupId: 'g1' }),
      row({ id: 'r3', groupId: 'g2', status: 'SENDING' }),
    ];
    const { service } = outbox(rows);

    await expect(service.supersedeUnsent('c1')).resolves.toBe(3);
    expect(rows.map((r) => r.status)).toEqual([
      'SUPERSEDED',
      'SUPERSEDED',
      'SUPERSEDED',
    ]);
  });

  it('una respuesta con una burbuja ya enviada sale completa: no se toca', async () => {
    const rows = [
      row({ id: 'r1', groupId: 'g1', status: 'SENT' }),
      row({ id: 'r2', groupId: 'g1', status: 'PENDING' }),
    ];
    const { service, prisma } = outbox(rows);

    await expect(service.supersedeUnsent('c1')).resolves.toBe(0);
    expect(prisma.outboundReply.updateMany).not.toHaveBeenCalled();
    expect(rows[1].status).toBe('PENDING');
  });

  it('una respuesta de un turno que ya hizo una acción no se descarta', async () => {
    const rows = [
      row({ id: 'r1', groupId: 'g1', supersedable: false }),
      row({ id: 'r2', groupId: 'g2' }),
    ];
    const { service } = outbox(rows);

    await expect(service.supersedeUnsent('c1')).resolves.toBe(1);
    expect(rows.map((r) => r.status)).toEqual(['PENDING', 'SUPERSEDED']);
  });

  it('no toca las respuestas de otras conversaciones', async () => {
    const rows = [row({ id: 'r1', groupId: 'g1', conversationId: 'c2' })];
    const { service } = outbox(rows);

    await expect(service.supersedeUnsent('c1')).resolves.toBe(0);
    expect(rows[0].status).toBe('PENDING');
  });
});
