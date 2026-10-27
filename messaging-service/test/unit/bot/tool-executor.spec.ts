import { ToolExecutorService } from 'src/bot/tools/ToolExecutor.service';
import {
  canonicalJson,
  setByPath,
  stripSchemaPath,
} from 'src/bot/tools/json-path.util';

describe('json-path.util', () => {
  it('inyecta en rutas anidadas creando objetos intermedios', () => {
    const params: Record<string, unknown> = { treatments: ['t1'] };
    setByPath(params, 'client.phone', '573001112233');
    expect(params).toEqual({
      treatments: ['t1'],
      client: { phone: '573001112233' },
    });
  });

  it('rechaza rutas peligrosas (prototype pollution)', () => {
    expect(() => setByPath({}, '__proto__.polluted', true)).toThrow();
  });

  it('oculta al modelo el campo anidado inyectado', () => {
    const schema = {
      type: 'object',
      required: ['client'],
      properties: {
        client: {
          type: 'object',
          required: ['phone', 'name'],
          properties: { phone: { type: 'string' }, name: { type: 'string' } },
        },
      },
    };
    const exposed = stripSchemaPath(schema, 'client.phone');
    expect(exposed.properties.client.properties.phone).toBeUndefined();
    expect(exposed.properties.client.required).toEqual(['name']);
  });

  it('canonicalJson es estable con claves anidadas en otro orden', () => {
    expect(canonicalJson({ b: 1, a: { d: 1, c: 2 } })).toBe(
      canonicalJson({ a: { c: 2, d: 1 }, b: 1 }),
    );
  });
});

describe('ToolExecutorService', () => {
  const tool = {
    id: 'tool-1',
    isActive: true,
    httpMethod: 'POST',
    endpointUrl: 'https://backend.test/conduit/booking/reservations',
    authHeaderName: 'X-API-Key',
    authSecretEncrypted: 'enc',
    maxImageSizeBytes: null,
  };
  const prisma = {
    toolDefinition: { findUnique: jest.fn().mockResolvedValue(tool) },
    toolInvocation: {
      upsert: jest.fn().mockImplementation(({ create }) => ({
        id: 'inv-1',
        ...create,
      })),
    },
  };
  const service = new ToolExecutorService(
    prisma as any,
    { decrypt: () => 'secret-key' } as any,
  );
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  function reply(status: number, body: unknown) {
    return {
      ok: status < 300,
      status,
      json: () => Promise.resolve(body),
    } as Response;
  }

  it('inyecta el teléfono verificado y envía la identidad del chat en headers', async () => {
    const fetchMock = jest.fn().mockResolvedValue(reply(201, { ok: true }));
    global.fetch = fetchMock;

    await service.execute({
      toolDefinitionId: 'tool-1',
      conversationId: 'conv-1',
      params: { treatments: ['t1'], client: { name: 'Ana', phone: '999' } },
      injectedPhone: '573001112233',
      phoneParamName: 'client.phone',
      contactAddress: '573001112233',
      turnId: 'msg-9',
    });

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body).client).toEqual({
      name: 'Ana',
      phone: '573001112233',
    });
    expect(init.headers['X-Conduit-Contact-Phone']).toBe('+573001112233');
    expect(init.headers['X-Conduit-Conversation-Id']).toBe('conv-1');
    expect(init.headers['X-API-Key']).toBe('secret-key');
  });

  it('un chat solo con LID viaja como LID, sin teléfono', async () => {
    const fetchMock = jest.fn().mockResolvedValue(reply(200, {}));
    global.fetch = fetchMock;

    await service.execute({
      toolDefinitionId: 'tool-1',
      conversationId: 'conv-1',
      params: {},
      contactAddress: '123456789012345@lid',
    });

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers['X-Conduit-Contact-Lid']).toBe('123456789012345');
    expect(init.headers['X-Conduit-Contact-Phone']).toBeUndefined();
  });

  it('reintenta con la misma clave si la operación sigue en curso (409)', async () => {
    jest.useFakeTimers();
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(reply(409, { code: 'IDEMPOTENCY_IN_PROGRESS' }))
      .mockResolvedValueOnce(reply(201, { id: 'res-1' }));
    global.fetch = fetchMock;

    const promise = service.execute({
      toolDefinitionId: 'tool-1',
      conversationId: 'conv-1',
      params: { a: 1 },
      turnId: 't1',
    });
    await jest.runAllTimersAsync();
    const outcome = await promise;
    jest.useRealTimers();

    expect(outcome.status).toBe('SUCCESS');
    const keys = fetchMock.mock.calls.map(
      ([, init]) => init.headers['X-Conduit-Idempotency-Key'],
    );
    expect(keys[0]).toBe(keys[1]);
  });

  it('envía el id del turno como correlation id para seguir el mensaje hasta el backend', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(reply(200, { ok: true })) as never;
    await service.execute({
      toolDefinitionId: 'tool-1',
      conversationId: 'conv-1',
      params: { treatmentIds: ['t1'] },
      turnId: '0b9f6c1e-5a1d-4d7e-9b53-3a1c2f7d8e90',
    });
    const headers = (global.fetch as jest.Mock).mock.calls[0][1].headers;
    expect(headers['X-Correlation-Id']).toBe(
      '0b9f6c1e-5a1d-4d7e-9b53-3a1c2f7d8e90',
    );
  });

  it('una herramienta colgada termina dentro del presupuesto del turno', async () => {
    global.fetch = jest.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        }),
    ) as never;
    const started = Date.now();
    const outcome = await service.execute({
      toolDefinitionId: 'tool-1',
      conversationId: 'conv-1',
      params: { treatmentIds: ['t1'] },
      turnId: 'turn-1',
      deadlineAt: Date.now() + 1_200,
    });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(outcome.status).toBe('TECHNICAL_ERROR');
    expect(outcome.errorDetail).toMatch(/Timeout/);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('un turno nuevo genera otra clave de idempotencia', async () => {
    const fetchMock = jest.fn().mockResolvedValue(reply(201, {}));
    global.fetch = fetchMock;
    const base = {
      toolDefinitionId: 'tool-1',
      conversationId: 'conv-1',
      params: { slot: '10:00' },
    };

    await service.execute({ ...base, turnId: 'turno-1' });
    await service.execute({ ...base, turnId: 'turno-2' });

    const [k1, k2] = fetchMock.mock.calls.map(
      ([, init]) => init.headers['X-Conduit-Idempotency-Key'],
    );
    expect(k1).not.toBe(k2);
  });
});
