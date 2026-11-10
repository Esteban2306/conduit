import { GroundingResolver } from 'src/bot/specialists/GroundingResolver';

const TENANT = 'tenant-1';
const BOT = 'bot-1';
const CONVERSATION = 'conv-1';

type Source = Record<string, unknown>;

const toolSource = (extra: Source = {}) => ({
  key: 'minimo',
  kind: 'TOOL',
  name: 'consultar_anticipo',
  valuePath: 'data.anticipo.monto',
  maxAgeSeconds: 60,
  required: false,
  ...extra,
});

const mappingSource = (extra: Source = {}) => ({
  key: 'titular',
  kind: 'EXTERNAL_MAPPING',
  name: 'vars.titular',
  maxAgeSeconds: 60,
  required: false,
  ...extra,
});

const tool = (extra: Source = {}) => ({
  definitionId: 'def-1',
  spec: { name: 'consultar_anticipo' },
  readOnly: true,
  requiresImageAttachment: false,
  pausesBotMinutes: null,
  injectPhoneParamName: 'phone',
  ...extra,
});

interface World {
  tools?: Source[];
  response?: unknown;
  status?: string;
  executeImpl?: (req: unknown) => Promise<unknown>;
  mapping?: { value: string } | null;
  timeoutMs?: number;
}

function build(world: World = {}) {
  const tools = {
    getActiveToolsForBot: jest.fn(() =>
      Promise.resolve(world.tools ?? [tool()]),
    ),
  };
  const executor = {
    execute: jest.fn(
      world.executeImpl ??
        (() =>
          Promise.resolve({
            status: world.status ?? 'SUCCESS',
            responseBody:
              'response' in world
                ? world.response
                : { data: { anticipo: { monto: 30000 } } },
            httpStatus: 200,
            errorDetail: null,
            invocationId: null,
          })),
    ),
  };
  const prisma = {
    externalVariable: {
      findFirst: jest.fn(() =>
        Promise.resolve(world.mapping === undefined ? null : world.mapping),
      ),
    },
  };
  const config = {
    get: (key: string) =>
      key === 'specialists.groundingTimeoutMs'
        ? (world.timeoutMs ?? 5000)
        : undefined,
  };
  const resolver = new GroundingResolver(
    config as never,
    prisma as never,
    tools as never,
    executor as never,
  );
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  (resolver as unknown as { logger: object }).logger = logger;

  const resolve = (sources: Source[], over: Record<string, unknown> = {}) =>
    resolver.resolve({
      tenantId: TENANT,
      botConfigId: BOT,
      conversationId: CONVERSATION,
      contactAddress: '573001112233',
      sources: sources as never,
      neededKeys: new Set(sources.map((s) => s.key as string)),
      ...over,
    });

  return { resolver, resolve, tools, executor, prisma, logger };
}

const mappingWhere = (w: ReturnType<typeof build>) =>
  (
    w.prisma.externalVariable.findFirst.mock.calls[0] as unknown as [
      { where: Record<string, unknown> },
    ]
  )[0].where;

describe('GroundingResolver', () => {
  describe('herramientas de solo lectura', () => {
    it('lee el valor con la ruta indicada', async () => {
      const w = build();
      const outcome = await w.resolve([toolSource()]);
      expect(outcome).toEqual({
        values: { minimo: 30000 },
        unavailable: [],
        requiredUnavailable: false,
      });
    });

    it('acepta textos y booleanos además de números', async () => {
      const w = build({
        response: { data: { anticipo: { monto: ' 30000 ' } } },
      });
      expect((await w.resolve([toolSource()])).values.minimo).toBe('30000');
    });

    it('llama a la herramienta del bot sin parámetros del modelo y con la identidad del chat', async () => {
      const w = build();
      await w.resolve([toolSource()]);

      expect(w.tools.getActiveToolsForBot).toHaveBeenCalledWith(BOT);
      const call = (
        w.executor.execute.mock.calls[0] as unknown as [Record<string, unknown>]
      )[0];
      expect(call).toMatchObject({
        toolDefinitionId: 'def-1',
        conversationId: CONVERSATION,
        params: {},
        injectedPhone: '573001112233',
        phoneParamName: 'phone',
        contactAddress: '573001112233',
      });
      expect(typeof call.deadlineAt).toBe('number');
    });

    it('un LID no se inyecta como teléfono', async () => {
      const w = build();
      await w.resolve([toolSource()], { contactAddress: '12345@lid' });
      const call = (
        w.executor.execute.mock.calls[0] as unknown as [Record<string, unknown>]
      )[0];
      expect(call.injectedPhone).toBeUndefined();
      expect(call.phoneParamName).toBeUndefined();
      expect(call.contactAddress).toBe('12345@lid');
    });

    it('una herramienta sin inyección de teléfono no recibe el parámetro', async () => {
      const w = build({ tools: [tool({ injectPhoneParamName: null })] });
      await w.resolve([toolSource()]);
      const call = (
        w.executor.execute.mock.calls[0] as unknown as [Record<string, unknown>]
      )[0];
      expect(call.injectedPhone).toBeUndefined();
    });

    it.each([
      ['no es de solo lectura', { readOnly: false }],
      ['exige una imagen adjunta', { requiresImageAttachment: true }],
      ['pausa al bot', { pausesBotMinutes: 240 }],
    ])(
      'rechaza una herramienta que %s y nunca la ejecuta',
      async (_n, extra) => {
        const w = build({ tools: [tool(extra)] });
        const outcome = await w.resolve([toolSource()]);
        expect(outcome.unavailable).toEqual([
          { key: 'minimo', reason: 'TOOL_NOT_ALLOWED' },
        ]);
        expect(w.executor.execute).not.toHaveBeenCalled();
      },
    );

    it('una herramienta inexistente queda como no disponible', async () => {
      const w = build({ tools: [] });
      expect((await w.resolve([toolSource()])).unavailable).toEqual([
        { key: 'minimo', reason: 'TOOL_NOT_FOUND' },
      ]);
    });

    it.each(['BUSINESS_ERROR', 'TECHNICAL_ERROR'])(
      'una respuesta %s deja el valor no disponible',
      async (status) => {
        const w = build({ status });
        expect((await w.resolve([toolSource()])).unavailable).toEqual([
          { key: 'minimo', reason: 'TOOL_FAILED' },
        ]);
      },
    );

    it.each([
      ['la ruta no existe', { data: {} }, 'VALUE_MISSING'],
      [
        'el valor es nulo',
        { data: { anticipo: { monto: null } } },
        'VALUE_MISSING',
      ],
      ['la respuesta no es JSON', null, 'VALUE_MISSING'],
      [
        'el valor es un objeto',
        { data: { anticipo: { monto: { a: 1 } } } },
        'VALUE_NOT_SCALAR',
      ],
      [
        'el valor es un arreglo',
        { data: { anticipo: { monto: [1] } } },
        'VALUE_NOT_SCALAR',
      ],
      [
        'el texto está vacío',
        { data: { anticipo: { monto: '' } } },
        'VALUE_NOT_SCALAR',
      ],
    ])('si %s queda no disponible', async (_n, response, reason) => {
      const w = build({ response });
      expect((await w.resolve([toolSource()])).unavailable).toEqual([
        { key: 'minimo', reason },
      ]);
    });

    it('si la herramienta lanza, queda no disponible sin romper', async () => {
      const w = build({ executeImpl: () => Promise.reject(new Error('boom')) });
      const outcome = await w.resolve([toolSource()]);
      expect(outcome.unavailable).toEqual([{ key: 'minimo', reason: 'ERROR' }]);
    });
  });

  describe('selección de fuentes', () => {
    it('solo resuelve las claves necesarias y las obligatorias', async () => {
      const w = build({
        tools: [
          tool(),
          tool({ definitionId: 'def-2', spec: { name: 'otra' } }),
          tool({ definitionId: 'def-3', spec: { name: 'obligatoria' } }),
        ],
      });
      await w.resolve(
        [
          toolSource(),
          toolSource({ key: 'otra', name: 'otra' }),
          toolSource({ key: 'oblig', name: 'obligatoria', required: true }),
        ],
        { neededKeys: new Set(['minimo']) },
      );
      const ids = w.executor.execute.mock.calls.map(
        (call) =>
          (call as unknown as [{ toolDefinitionId: string }])[0]
            .toolDefinitionId,
      );
      expect(ids.sort()).toEqual(['def-1', 'def-3']);
    });

    it('sin fuentes necesarias no consulta nada', async () => {
      const w = build();
      const outcome = await w.resolve([toolSource()], {
        neededKeys: new Set(),
      });
      expect(outcome).toEqual({
        values: {},
        unavailable: [],
        requiredUnavailable: false,
      });
      expect(w.tools.getActiveToolsForBot).not.toHaveBeenCalled();
    });

    it('carga la lista de herramientas una sola vez para varias fuentes', async () => {
      const w = build();
      await w.resolve([
        toolSource(),
        toolSource({ key: 'otro', valuePath: 'data.anticipo.monto' }),
      ]);
      expect(w.tools.getActiveToolsForBot).toHaveBeenCalledTimes(1);
    });

    it('resuelve las fuentes en paralelo', async () => {
      let inFlight = 0;
      let peak = 0;
      const w = build({
        executeImpl: async () => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await new Promise((r) => setImmediate(r));
          inFlight--;
          return {
            status: 'SUCCESS',
            responseBody: { data: { anticipo: { monto: 1 } } },
            httpStatus: 200,
            errorDetail: null,
            invocationId: null,
          };
        },
      });
      await w.resolve([
        toolSource(),
        toolSource({ key: 'dos', valuePath: 'data.anticipo.otro' }),
        toolSource({ key: 'tres', valuePath: 'data.anticipo.mas' }),
      ]);
      expect(peak).toBe(3);
    });

    it('marca requiredUnavailable solo si falla una obligatoria', async () => {
      const failing = build({ status: 'TECHNICAL_ERROR' });
      expect(
        (await failing.resolve([toolSource({ required: true })]))
          .requiredUnavailable,
      ).toBe(true);
      const optional = build({ status: 'TECHNICAL_ERROR' });
      expect((await optional.resolve([toolSource()])).requiredUnavailable).toBe(
        false,
      );
    });
  });

  describe('tiempo máximo', () => {
    beforeEach(() =>
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] }),
    );
    afterEach(() => jest.useRealTimers());

    it('una herramienta colgada se corta con TIMEOUT y no frena a las demás', async () => {
      const w = build({
        timeoutMs: 1000,
        tools: [
          tool(),
          tool({ definitionId: 'def-2', spec: { name: 'rapida' } }),
        ],
        executeImpl: undefined,
      });
      w.executor.execute.mockImplementation((req: unknown) =>
        (req as { toolDefinitionId: string }).toolDefinitionId === 'def-1'
          ? new Promise(() => undefined)
          : Promise.resolve({
              status: 'SUCCESS',
              responseBody: { data: { anticipo: { monto: 7 } } },
              httpStatus: 200,
              errorDetail: null,
              invocationId: null,
            }),
      );

      const pending = w.resolve([
        toolSource({ required: true }),
        toolSource({ key: 'rapida', name: 'rapida' }),
      ]);
      await jest.advanceTimersByTimeAsync(1100);
      const outcome = await pending;

      expect(outcome.values).toEqual({ rapida: 7 });
      expect(outcome.unavailable).toEqual([
        { key: 'minimo', reason: 'TIMEOUT' },
      ]);
      expect(outcome.requiredUnavailable).toBe(true);
    });

    it('pasa al ejecutor el fin del presupuesto para limitar sus reintentos', async () => {
      const w = build({ timeoutMs: 2000 });
      const before = Date.now();
      await w.resolve([toolSource()]);
      const call = (
        w.executor.execute.mock.calls[0] as unknown as [{ deadlineAt: number }]
      )[0];
      expect(call.deadlineAt - before).toBeGreaterThanOrEqual(1990);
      expect(call.deadlineAt - before).toBeLessThanOrEqual(2100);
    });
  });

  describe('caché corta', () => {
    beforeEach(() =>
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] }),
    );
    afterEach(() => jest.useRealTimers());

    it('no repite la consulta dentro de la vigencia', async () => {
      const w = build();
      await w.resolve([toolSource({ maxAgeSeconds: 30 })]);
      const second = await w.resolve([toolSource({ maxAgeSeconds: 30 })]);
      expect(w.executor.execute).toHaveBeenCalledTimes(1);
      expect(second.values.minimo).toBe(30000);
    });

    it('vuelve a consultar al vencer la vigencia', async () => {
      const w = build();
      await w.resolve([toolSource({ maxAgeSeconds: 30 })]);
      await jest.advanceTimersByTimeAsync(31_000);
      await w.resolve([toolSource({ maxAgeSeconds: 30 })]);
      expect(w.executor.execute).toHaveBeenCalledTimes(2);
    });

    it('con vigencia 0 nunca usa caché', async () => {
      const w = build();
      await w.resolve([toolSource({ maxAgeSeconds: 0 })]);
      await w.resolve([toolSource({ maxAgeSeconds: 0 })]);
      expect(w.executor.execute).toHaveBeenCalledTimes(2);
    });

    it('no mezcla conversaciones, bots ni tenants', async () => {
      const w = build();
      await w.resolve([toolSource()]);
      await w.resolve([toolSource()], { conversationId: 'otra' });
      await w.resolve([toolSource()], { botConfigId: 'otro-bot' });
      await w.resolve([toolSource()], { tenantId: 'otro-tenant' });
      expect(w.executor.execute).toHaveBeenCalledTimes(4);
    });

    it('no mezcla fuentes con distinta ruta de valor', async () => {
      const w = build({
        response: { data: { anticipo: { monto: 1 }, otro: 2 } },
      });
      await w.resolve([toolSource()]);
      const other = await w.resolve([toolSource({ valuePath: 'data.otro' })]);
      expect(other.values.minimo).toBe(2);
      expect(w.executor.execute).toHaveBeenCalledTimes(2);
    });

    it('un fallo no se guarda en caché', async () => {
      const w = build({ status: 'TECHNICAL_ERROR' });
      await w.resolve([toolSource()]);
      await w.resolve([toolSource()]);
      expect(w.executor.execute).toHaveBeenCalledTimes(2);
    });

    it('dos consultas simultáneas iguales comparten una sola llamada', async () => {
      let release: () => void = () => undefined;
      const gate = new Promise<void>((r) => (release = r));
      const w = build({
        executeImpl: async () => {
          await gate;
          return {
            status: 'SUCCESS',
            responseBody: { data: { anticipo: { monto: 9 } } },
            httpStatus: 200,
            errorDetail: null,
            invocationId: null,
          };
        },
      });
      const first = w.resolve([toolSource({ maxAgeSeconds: 0 })]);
      const second = w.resolve([toolSource({ maxAgeSeconds: 0 })]);
      await new Promise((r) => setImmediate(r));
      release();
      expect((await first).values.minimo).toBe(9);
      expect((await second).values.minimo).toBe(9);
      expect(w.executor.execute).toHaveBeenCalledTimes(1);
    });

    it('la caché no crece sin límite', async () => {
      const w = build();
      for (let i = 0; i < 520; i++) {
        await w.resolve([toolSource()], { conversationId: `c-${i}` });
      }
      expect(
        (w.resolver as unknown as { cache: Map<string, unknown> }).cache.size,
      ).toBeLessThanOrEqual(500);
    });
  });

  describe('mapeos externos', () => {
    it('lee la variable guardada del bot con espacio de nombres y clave', async () => {
      const w = build({ mapping: { value: ' Spa Demo ' } });
      const outcome = await w.resolve([mappingSource()]);

      expect(outcome.values.titular).toBe('Spa Demo');
      expect(mappingWhere(w)).toMatchObject({
        botConfigId: BOT,
        namespace: 'vars',
        key: 'titular',
      });
    });

    it('excluye las variables vencidas en la consulta', async () => {
      const w = build({ mapping: { value: 'x' } });
      await w.resolve([mappingSource()]);
      const where = mappingWhere(w) as {
        OR: Array<{ expiresAt: { gt: Date } | null }>;
      };
      expect(where.OR).toHaveLength(2);
      expect(where.OR[0]).toEqual({ expiresAt: null });
      expect(where.OR[1].expiresAt?.gt).toBeInstanceOf(Date);
    });

    it('una clave con puntos conserva todo después del primer punto', async () => {
      const w = build({ mapping: { value: 'x' } });
      await w.resolve([mappingSource({ name: 'reserva.cliente.titular' })]);
      expect(mappingWhere(w)).toMatchObject({
        namespace: 'reserva',
        key: 'cliente.titular',
      });
    });

    it('una variable inexistente queda no disponible', async () => {
      const w = build({ mapping: null });
      expect((await w.resolve([mappingSource()])).unavailable).toEqual([
        { key: 'titular', reason: 'MAPPING_NOT_FOUND' },
      ]);
    });

    it('con valuePath lee dentro de un JSON guardado', async () => {
      const w = build({ mapping: { value: '{"anticipo":{"monto":45000}}' } });
      const outcome = await w.resolve([
        mappingSource({ valuePath: 'anticipo.monto' }),
      ]);
      expect(outcome.values.titular).toBe(45000);
    });

    it('con valuePath y un texto que no es JSON queda no disponible', async () => {
      const w = build({ mapping: { value: 'no es json' } });
      expect(
        (await w.resolve([mappingSource({ valuePath: 'a.b' })])).unavailable,
      ).toEqual([{ key: 'titular', reason: 'VALUE_NOT_SCALAR' }]);
    });

    it('un valor demasiado largo no se acepta', async () => {
      const w = build({ mapping: { value: 'x'.repeat(1001) } });
      expect((await w.resolve([mappingSource()])).unavailable[0].reason).toBe(
        'VALUE_NOT_SCALAR',
      );
    });

    it('un texto de unas instrucciones de pago sí se acepta', async () => {
      const w = build({ mapping: { value: 'x'.repeat(600) } });
      const out = await w.resolve([mappingSource()]);
      expect(out.unavailable).toEqual([]);
    });

    it('no usa herramientas', async () => {
      const w = build({ mapping: { value: 'x' } });
      await w.resolve([mappingSource()]);
      expect(w.tools.getActiveToolsForBot).not.toHaveBeenCalled();
      expect(w.executor.execute).not.toHaveBeenCalled();
    });
  });

  describe('privacidad', () => {
    it('los valores leídos no aparecen en los logs', async () => {
      const secret = 'VALOR-CONFIDENCIAL-12345';
      const w = build({ mapping: { value: secret } });
      await w.resolve([mappingSource(), toolSource()]);
      await w.resolve([mappingSource({ valuePath: 'x.y' })]);
      expect(
        JSON.stringify([w.logger.log.mock.calls, w.logger.warn.mock.calls]),
      ).not.toContain(secret);
    });
  });
});
