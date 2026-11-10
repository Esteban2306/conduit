import { ContextBuilder } from 'src/bot/prompt/ContextBuilder';
import { ConversationService } from 'src/bot/conversation/ConversationService';
import {
  IMAGE_WARNING_KEY,
  warningsOf,
} from 'src/bot/conversation/image-warning';

describe('warningsOf', () => {
  it('sin advertencia o con la clave en null no devuelve nada', () => {
    expect(warningsOf({})).toEqual([]);
    expect(warningsOf(null)).toEqual([]);
    expect(warningsOf({ [IMAGE_WARNING_KEY]: null })).toEqual([]);
  });

  it('expone código, motivo y desde cuándo', () => {
    expect(
      warningsOf({
        [IMAGE_WARNING_KEY]: {
          code: 'IMAGE_NOT_ANALYZED',
          reason: 'PROVIDER_UNAVAILABLE',
          at: '2026-11-10T10:00:00.000Z',
        },
      }),
    ).toEqual([
      {
        code: 'IMAGE_NOT_ANALYZED',
        reason: 'PROVIDER_UNAVAILABLE',
        since: '2026-11-10T10:00:00.000Z',
      },
    ]);
  });

  it.each([
    'texto',
    42,
    [],
    { reason: 'INVENTADO' },
    { reason: 7 },
    { at: 'x' },
  ])('un valor corrupto (%j) se ignora', (value) => {
    expect(warningsOf({ [IMAGE_WARNING_KEY]: value })).toEqual([]);
  });
});

describe('la advertencia no entra al prompt', () => {
  it('el constructor de contexto la excluye', () => {
    const { block } = new ContextBuilder().build(
      {
        clientName: 'Ana',
        [IMAGE_WARNING_KEY]: {
          code: 'IMAGE_NOT_ANALYZED',
          reason: 'NOT_RUN',
          at: '2026-11-10T10:00:00.000Z',
        },
      },
      null,
    );
    expect(block).toContain('Ana');
    expect(block).not.toContain('IMAGE_NOT_ANALYZED');
    expect(block).not.toContain('NOT_RUN');
    expect(block).not.toContain(IMAGE_WARNING_KEY);
  });
});

describe('listado del panel', () => {
  const row = (context: unknown) => ({
    id: 'c1',
    phoneNumber: '573001112233',
    status: 'ACTIVE',
    context,
    summary: null,
    lastConnectionId: null,
    lastMessageAt: new Date(),
    createdAt: new Date(),
    messages: [],
  });
  const list = async (...contexts: unknown[]) => {
    const prisma = {
      conversation: {
        findMany: jest.fn().mockResolvedValue(contexts.map(row)),
        count: jest.fn().mockResolvedValue(contexts.length),
      },
    };
    const service = new ConversationService(prisma as never, {} as never);
    return (await service.listForAdmin('bot', {})).data;
  };

  it('manda la advertencia solo en las conversaciones afectadas y no expone el contexto', async () => {
    const data = await list(
      {
        [IMAGE_WARNING_KEY]: {
          reason: 'ANALYSIS_ERROR',
          at: '2026-11-10T10:00:00.000Z',
        },
      },
      {},
      { [IMAGE_WARNING_KEY]: null },
    );
    expect(data[0].warnings).toEqual([
      {
        code: 'IMAGE_NOT_ANALYZED',
        reason: 'ANALYSIS_ERROR',
        since: '2026-11-10T10:00:00.000Z',
      },
    ]);
    expect(data[1].warnings).toEqual([]);
    expect(data[2].warnings).toEqual([]);
    expect(data[0]).not.toHaveProperty('context');
  });
});
