const anthropicCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => ({
  __esModule: true,
  default: jest
    .fn()
    .mockImplementation(() => ({ messages: { create: anthropicCreate } })),
}));
const openaiCreate = jest.fn();
jest.mock('openai', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    chat: { completions: { create: openaiCreate } },
  })),
}));
jest.mock('src/bot/helper/ImageOptimizer', () => ({
  ImageOptimizer: {
    optimizeForExtraction: (buffer: Buffer) => Promise.resolve(buffer),
  },
}));

import { GUARDS_METADATA } from '@nestjs/common/constants';
import { randomBytes } from 'crypto';
import sharp from 'sharp';
import { ApiAuthGuard } from 'src/auth/guards/api-auth.guard';
import { TenantAdminGuard } from 'src/auth/guards/tenant-admin.guard';
import { AnthropicProvider } from 'src/bot/ai/providers/AnthropicProvider';
import { OpenAIProvider } from 'src/bot/ai/providers/OpenAIProvider';
import { SpecialistVerificationController } from 'src/bot/specialists/admin/SpecialistVerification.controller';
import { SpecialistVerificationService } from 'src/bot/specialists/admin/SpecialistVerificationService';
import {
  decodeCursor,
  encodeCursor,
  listVerificationsSchema,
} from 'src/bot/specialists/admin/specialist-verification.schemas';
import {
  buildPriceTable,
  estimateCostUsd,
  priceFor,
} from 'src/bot/specialists/pricing';
import { SpecialistRuntime } from 'src/bot/specialists/SpecialistRuntime';

const analyzeInput = {
  prompt: 'p',
  systemPrompt: 's',
  imageBuffer: randomBytes(16),
  mimeType: 'image/jpeg',
  model: 'claude-haiku-5-5',
  apiKey: `sk-ant-${'x'.repeat(30)}`,
};

describe('proveedores: desglose de tokens en el análisis de imágenes', () => {
  it('Anthropic devuelve entrada, salida, caché y razonamiento', async () => {
    anthropicCreate.mockResolvedValue({
      content: [{ type: 'text', text: '{}' }],
      usage: {
        input_tokens: 1200,
        output_tokens: 80,
        cache_read_input_tokens: 5,
        cache_creation_input_tokens: 7,
        output_tokens_details: { thinking_tokens: 30 },
      },
      stop_reason: 'end_turn',
      model: 'claude-haiku-5-5',
    });
    const result = await new AnthropicProvider().analyzeImage(analyzeInput);
    expect(result.usage).toEqual({
      input: 1200,
      output: 80,
      cacheRead: 5,
      cacheWrite: 7,
      thinking: 30,
    });
    expect(result.tokensUsed).toBe(1280);
    expect(result.stopReason).toBe('end_turn');
  });

  it('Anthropic sin campos opcionales usa cero', async () => {
    anthropicCreate.mockResolvedValue({
      content: [],
      usage: { input_tokens: 3, output_tokens: 1 },
      model: 'm',
    });
    const result = await new AnthropicProvider().analyzeImage(analyzeInput);
    expect(result.usage).toEqual({
      input: 3,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      thinking: 0,
    });
  });

  it('OpenAI devuelve entrada y salida', async () => {
    openaiCreate.mockResolvedValue({
      choices: [{ message: { content: '{}' } }],
      usage: { prompt_tokens: 900, completion_tokens: 40, total_tokens: 940 },
      model: 'gpt-x',
    });
    const result = await new OpenAIProvider().analyzeImage({
      ...analyzeInput,
      model: 'gpt-x',
    });
    expect(result.usage).toMatchObject({ input: 900, output: 40 });
    expect(result.tokensUsed).toBe(940);
  });
});

describe('tabla de precios', () => {
  const table = buildPriceTable(undefined);

  it('estima el costo con entrada y salida por separado', () => {
    expect(estimateCostUsd(table, 'claude-haiku-5-5', 2000, 100)).toBeCloseTo(
      0.0025,
      6,
    );
  });

  it('un modelo sin precio no inventa un costo', () => {
    expect(estimateCostUsd(table, 'modelo-raro', 100, 100)).toBeNull();
    expect(estimateCostUsd(table, null, 100, 100)).toBeNull();
  });

  it('sin desglose de tokens no hay costo', () => {
    expect(estimateCostUsd(table, 'claude-haiku-5-5', null, 10)).toBeNull();
    expect(estimateCostUsd(table, 'claude-haiku-5-5', 10, null)).toBeNull();
  });

  it('el entorno reemplaza y el prefijo más largo gana', () => {
    const custom = buildPriceTable(
      JSON.stringify({
        'claude-haiku': { inputPerMTok: 10, outputPerMTok: 20 },
        'claude-haiku-5-5': { inputPerMTok: 2, outputPerMTok: 4 },
        'otro-': { inputPerMTok: 1, outputPerMTok: 1 },
      }),
    );
    expect(priceFor(custom, 'claude-haiku-5-5')).toEqual({
      inputPerMTok: 2,
      outputPerMTok: 4,
    });
    expect(priceFor(custom, 'claude-haiku-4-5')?.inputPerMTok).toBe(10);
    expect(priceFor(custom, 'otro-modelo')?.inputPerMTok).toBe(1);
  });

  it.each([
    'no es json',
    '[]',
    '{"claude-haiku":{"inputPerMTok":-1,"outputPerMTok":1}}',
    '{"claude-haiku":{"inputPerMTok":"1","outputPerMTok":1}}',
    '{"claude-haiku":{"inputPerMTok":1}}',
  ])('un entorno inválido (%s) conserva la tabla base', (raw) => {
    expect(buildPriceTable(raw)).toEqual(table);
  });
});

describe('consulta de verificaciones: filtros y cursor', () => {
  it('acepta filtros válidos', () => {
    expect(
      listVerificationsSchema.safeParse({
        verdict: 'NEEDS_REVIEW',
        mode: 'ACTIVE',
        reasonCode: 'LOW_CONFIDENCE',
        limit: '50',
        pendingReview: 'true',
        from: '2026-11-01T00:00:00Z',
        to: '2026-11-09T00:00:00Z',
      }).success,
    ).toBe(true);
  });

  it.each([
    { verdict: 'APPROVED' },
    { reasonCode: 'minúscula' },
    { limit: '101' },
    { limit: '0' },
    { from: 'ayer' },
    { from: '2026-11-09T00:00:00Z', to: '2026-11-01T00:00:00Z' },
    { from: '2024-01-01T00:00:00Z', to: '2026-11-01T00:00:00Z' },
    { tenantId: 'otro' },
  ])('rechaza %j', (query) => {
    expect(listVerificationsSchema.safeParse(query).success).toBe(false);
  });

  it('el cursor viaja de ida y vuelta y rechaza basura', () => {
    const date = new Date('2026-11-09T10:00:00.123Z');
    expect(decodeCursor(encodeCursor(date, 'abc'))).toEqual({
      createdAt: date,
      id: 'abc',
    });
    expect(decodeCursor('%%%')).toBeNull();
    expect(decodeCursor(Buffer.from('nope').toString('base64url'))).toBeNull();
    expect(
      decodeCursor(Buffer.from('fecha|id').toString('base64url')),
    ).toBeNull();
  });
});

const png = () =>
  sharp({
    create: {
      width: 8,
      height: 8,
      channels: 3,
      background: { r: 200, g: 200, b: 200 },
    },
  })
    .png()
    .toBuffer();

function buildService(
  options: {
    limit?: number;
    specialist?: Record<string, unknown> | null;
    rows?: Record<string, unknown>[];
  } = {},
) {
  const specialist =
    options.specialist === undefined
      ? {
          id: 'esp-1',
          capability: 'payment-proof',
          version: 3,
          promptTemplate: 'prompt guardado',
          rules: { version: 1, rules: [] },
          contextSources: { version: 1, sources: [] },
        }
      : options.specialist;
  const prisma = {
    specialist: { findFirst: jest.fn(() => Promise.resolve(specialist)) },
    verificationRecord: {
      findMany: jest.fn(() => Promise.resolve(options.rows ?? [])),
      findFirst: jest.fn(() => Promise.resolve(options.rows?.[0] ?? null)),
      create: jest.fn(),
      update: jest.fn(),
    },
  };
  const runtime = {
    dryRun: jest.fn(() =>
      Promise.resolve({
        result: {
          version: 1,
          verdict: 'VALID',
          confidence: 0.9,
          fields: { amount: 1 },
          reasonCodes: ['NO_RULES_CONFIGURED'],
          humanSummary: 'ok',
        },
        modelUsed: 'claude-haiku-5-5',
        tokens: 1100,
        inputTokens: 1000,
        outputTokens: 100,
        latencyMs: 800,
      }),
    ),
  };
  const config = {
    get: (key: string) =>
      ({ 'specialists.dryRunPerMinute': options.limit ?? 10 })[key],
  };
  const service = new SpecialistVerificationService(
    prisma as never,
    runtime as never,
    config as never,
  );
  return { service, prisma, runtime };
}

describe('SpecialistVerificationService.dryRun', () => {
  it('prueba sin guardar nada y devuelve veredicto, tokens, latencia y costo', async () => {
    const { service, prisma, runtime } = buildService();
    const out = await service.dryRun(
      'tenant-1',
      'esp-1',
      { buffer: await png() },
      undefined,
    );
    expect(out).toMatchObject({
      dryRun: true,
      persisted: false,
      groundingSkipped: true,
      verdict: 'VALID',
      tokens: { total: 1100, input: 1000, output: 100 },
      latencyMs: 800,
      usedDraft: { promptTemplate: false, rules: false, contextSources: false },
    });
    expect(out.estimatedCostUsd).toBeCloseTo(0.0015, 6);
    expect(prisma.verificationRecord.create).not.toHaveBeenCalled();
    expect(prisma.verificationRecord.update).not.toHaveBeenCalled();
    const args = (
      runtime.dryRun.mock.calls[0] as unknown as [Record<string, unknown>]
    )[0];
    expect(args).toMatchObject({
      tenantId: 'tenant-1',
      promptTemplate: 'prompt guardado',
      version: 3,
    });
  });

  it('busca el especialista solo dentro del tenant y sin archivados', async () => {
    const { service, prisma } = buildService();
    await service.dryRun(
      'tenant-1',
      'esp-1',
      { buffer: await png() },
      undefined,
    );
    expect(prisma.specialist.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'esp-1', tenantId: 'tenant-1', archivedAt: null },
      }),
    );
  });

  it('usa el borrador del prompt y las reglas en lugar de lo guardado', async () => {
    const { service, runtime } = buildService();
    const rules = {
      version: 1,
      rules: [
        {
          field: 'amount',
          op: 'gte',
          ref: { literal: 50 },
          onFail: 'INVALID',
        },
      ],
    };
    const out = await service.dryRun(
      'tenant-1',
      'esp-1',
      { buffer: await png() },
      JSON.stringify({ promptTemplate: 'borrador', rules }),
    );
    const args = (
      runtime.dryRun.mock.calls[0] as unknown as [Record<string, unknown>]
    )[0];
    expect(args.promptTemplate).toBe('borrador');
    expect(args.rules).toEqual(rules);
    expect(out.usedDraft).toEqual({
      promptTemplate: true,
      rules: true,
      contextSources: false,
    });
  });

  it.each([
    ['sin archivo', undefined, undefined],
    ['archivo vacío', Buffer.alloc(0), undefined],
    ['no es una imagen', Buffer.from('hola mundo'), undefined],
    ['borrador no JSON', 'png', '{no'],
    ['borrador con campo ajeno', 'png', '{"status":"ACTIVE"}'],
    ['borrador con prompt vacío', 'png', '{"promptTemplate":""}'],
    ['borrador con reglas inválidas', 'png', '{"rules":{"version":9}}'],
  ])('rechaza con 400: %s', async (_name, file, draft) => {
    const { service, runtime } = buildService();
    const buffer = file === 'png' ? await png() : (file as Buffer | undefined);
    await expect(
      service.dryRun(
        'tenant-1',
        'esp-1',
        buffer ? { buffer } : undefined,
        draft,
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(runtime.dryRun).not.toHaveBeenCalled();
  });

  it('rechaza una imagen mayor al límite', async () => {
    const { service, runtime } = buildService();
    await expect(
      service.dryRun(
        'tenant-1',
        'esp-1',
        { buffer: Buffer.alloc(5 * 1024 * 1024 + 1) },
        undefined,
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(runtime.dryRun).not.toHaveBeenCalled();
  });

  it('un especialista de otro tenant o archivado da 404', async () => {
    const { service, runtime } = buildService({ specialist: null });
    await expect(
      service.dryRun('tenant-1', 'esp-x', { buffer: await png() }, undefined),
    ).rejects.toMatchObject({ status: 404 });
    expect(runtime.dryRun).not.toHaveBeenCalled();
  });

  it('limita las pruebas por tenant y minuto sin afectar a otro tenant', async () => {
    const { service, runtime } = buildService({ limit: 2 });
    const image = { buffer: await png() };
    await service.dryRun('t-a', 'esp-1', image, undefined);
    await service.dryRun('t-a', 'esp-1', image, undefined);
    await expect(
      service.dryRun('t-a', 'esp-1', image, undefined),
    ).rejects.toMatchObject({
      status: 429,
      response: { details: { limitPerMinute: 2 } },
    });
    await expect(
      service.dryRun('t-b', 'esp-1', image, undefined),
    ).resolves.toBeDefined();
    expect(runtime.dryRun).toHaveBeenCalledTimes(3);
  });

  it('el límite se libera al pasar el minuto', async () => {
    jest.useFakeTimers();
    try {
      const { service } = buildService({ limit: 1 });
      const image = { buffer: await png() };
      await service.dryRun('t-a', 'esp-1', image, undefined);
      await expect(
        service.dryRun('t-a', 'esp-1', image, undefined),
      ).rejects.toMatchObject({ status: 429 });
      jest.advanceTimersByTime(60_001);
      await expect(
        service.dryRun('t-a', 'esp-1', image, undefined),
      ).resolves.toBeDefined();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('SpecialistVerificationService.list', () => {
  const row = (id: string, minute: number) => ({
    id,
    createdAt: new Date(Date.UTC(2026, 10, 9, 10, minute)),
    modelUsed: 'claude-haiku-5-5',
    tokens: 1100,
    inputTokens: 1000,
    outputTokens: 100,
    verdict: 'VALID',
  });

  it('siempre filtra por el tenant del token y nunca selecciona imágenes', async () => {
    const { service, prisma } = buildService();
    await service.list('tenant-1', { verdict: 'INVALID' });
    const call = (
      prisma.verificationRecord.findMany.mock.calls[0] as unknown as [
        { where: Record<string, unknown>; select: Record<string, boolean> },
      ]
    )[0];
    expect(call.where).toMatchObject({
      tenantId: 'tenant-1',
      verdict: 'INVALID',
    });
    expect(Object.keys(call.select).join(',')).not.toMatch(
      /image|buffer|blob/i,
    );
  });

  it('un filtro de tenant en la consulta se rechaza', async () => {
    const { service } = buildService();
    await expect(
      service.list('tenant-1', { tenantId: 'otro' }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('pagina con cursor y presenta tokens y costo', async () => {
    const rows = [row('c', 3), row('b', 2), row('a', 1)];
    const { service } = buildService({ rows });
    const page = await service.list('tenant-1', { limit: '2' });
    expect(page.items.map((item) => item.id)).toEqual(['c', 'b']);
    expect(page.nextCursor).toEqual(expect.any(String));
    expect(page.items[0].tokens).toEqual({
      total: 1100,
      input: 1000,
      output: 100,
    });
    expect(page.items[0].estimatedCostUsd).toBeCloseTo(0.0015, 6);

    const last = await service.list('tenant-1', { limit: '3' });
    expect(last.nextCursor).toBeNull();
  });

  it('el cursor se traduce a una condición de orden estable', async () => {
    const { service, prisma } = buildService();
    const cursor = encodeCursor(new Date('2026-11-09T10:00:00Z'), 'zzz');
    await service.list('tenant-1', { cursor });
    const where = (
      prisma.verificationRecord.findMany.mock.calls[0] as unknown as [
        { where: { AND: unknown[] } },
      ]
    )[0].where;
    expect(JSON.stringify(where.AND)).toContain('zzz');
  });

  it('un cursor inválido da 400', async () => {
    const { service } = buildService();
    await expect(
      service.list('tenant-1', { cursor: 'basura' }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('pendientes de revisión: solo NEEDS_REVIEW/ERROR sin revisar', async () => {
    const { service, prisma } = buildService();
    await service.list('tenant-1', { pendingReview: 'true' });
    const where = (
      prisma.verificationRecord.findMany.mock.calls[0] as unknown as [
        { where: Record<string, unknown> },
      ]
    )[0].where;
    expect(where).toMatchObject({
      verdict: { in: ['NEEDS_REVIEW', 'ERROR'] },
      reviewedAt: null,
    });
  });

  it('ver una verificación ajena da 404', async () => {
    const { service, prisma } = buildService();
    await expect(service.get('tenant-1', 'x')).rejects.toMatchObject({
      status: 404,
    });
    expect(prisma.verificationRecord.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'x', tenantId: 'tenant-1' } }),
    );
  });
});

describe('permisos de verificaciones y dry-run', () => {
  const guardsOf = (target: object): unknown[] =>
    (Reflect.getMetadata(GUARDS_METADATA, target) as unknown[] | undefined) ??
    [];
  const proto = SpecialistVerificationController.prototype as unknown as Record<
    string,
    object
  >;

  it('exige autenticación en toda la clase', () => {
    expect(guardsOf(SpecialistVerificationController)).toContain(ApiAuthGuard);
  });

  it('el dry-run exige propietario o administrador', () => {
    expect(guardsOf(proto.dryRun)).toContain(TenantAdminGuard);
  });

  it('las consultas solo exigen autenticación', () => {
    expect(guardsOf(proto.list)).not.toContain(TenantAdminGuard);
    expect(guardsOf(proto.get)).not.toContain(TenantAdminGuard);
    expect(guardsOf(proto.summary)).not.toContain(TenantAdminGuard);
  });

  it('las métricas se piden con el tenant del token', () => {
    const metrics = { summary: jest.fn() };
    const controller = new SpecialistVerificationController(
      {} as never,
      metrics as never,
    );
    controller.summary(
      { sub: 'u', tenantId: 'tenant-token', role: 'MEMBER' },
      { mode: 'SHADOW' },
    );
    expect(metrics.summary).toHaveBeenCalledWith('tenant-token', {
      mode: 'SHADOW',
    });
  });

  it('delega con el tenant del token', () => {
    const service = { list: jest.fn(), get: jest.fn(), dryRun: jest.fn() };
    const controller = new SpecialistVerificationController(
      service as never,
      { summary: jest.fn() } as never,
    );
    const user = { sub: 'u', tenantId: 'tenant-token', role: 'ADMIN' };
    controller.list(user, { a: 1 });
    controller.get(user, 'v1');
    const file = { buffer: Buffer.from('x') } as Express.Multer.File;
    controller.dryRun(user, 's1', file, { draft: '{}' });
    expect(service.list).toHaveBeenCalledWith('tenant-token', { a: 1 });
    expect(service.get).toHaveBeenCalledWith('tenant-token', 'v1');
    expect(service.dryRun).toHaveBeenCalledWith(
      'tenant-token',
      's1',
      file,
      '{}',
    );
  });
});

describe('SpecialistRuntime: tokens y dry-run', () => {
  const extraction = JSON.stringify({
    version: 1,
    confidence: 0.8,
    fields: {
      amount: 150000,
      currency: 'COP',
      date: '2026-11-08',
      reference: 'AB-1',
      recipient: 'Spa Demo',
      legibility: 'CLEAR',
    },
  });

  function build(usage?: Record<string, number>) {
    const prisma = {
      botSpecialistBinding: {
        findFirst: jest.fn(() =>
          Promise.resolve({
            mode: 'SHADOW',
            timeoutMs: 12000,
            onFailure: 'DEGRADE',
            specialist: {
              id: 'esp-1',
              status: 'ACTIVE',
              version: 2,
              promptTemplate: 'guardado',
              contextSources: { version: 1, sources: [] },
              rules: { version: 1, rules: [] },
            },
          }),
        ),
      },
      verificationRecord: {
        create: jest.fn((args: { data: Record<string, unknown> }) =>
          Promise.resolve({ id: 'rec-1', ...args.data }),
        ),
      },
    };
    const orchestrator = {
      analyzeImageForSpecialist: jest.fn(() =>
        Promise.resolve({
          content: extraction,
          tokensUsed: 1100,
          modelUsed: 'm',
          usage,
        }),
      ),
    };
    const ledger = {
      passportTtlMs: () => 3_600_000,
      checkByHash: jest.fn(() => Promise.resolve({ kind: 'NONE' })),
      checkByFingerprint: jest.fn(() => Promise.resolve({ kind: 'NONE' })),
    };
    const grounding = {
      resolve: jest.fn(() =>
        Promise.resolve({
          values: {},
          unavailable: [],
          requiredUnavailable: false,
        }),
      ),
    };
    const config = {
      get: (key: string) =>
        ({ 'specialists.enabled': true, 'specialists.retentionDays': 30 })[key],
    };
    const runtime = new SpecialistRuntime(
      config as never,
      prisma as never,
      orchestrator as never,
      { publish: jest.fn() } as never,
      ledger as never,
      grounding as never,
    );
    return { runtime, prisma, orchestrator, ledger, grounding };
  }

  const image = randomBytes(64);

  it('guarda el desglose de entrada y salida', async () => {
    const { runtime, prisma } = build({
      input: 1000,
      output: 100,
      cacheRead: 0,
      cacheWrite: 0,
      thinking: 0,
    });
    await runtime.run({
      tenantId: 't',
      botConfigId: 'b',
      conversationId: 'c',
      capability: 'payment-proof',
      image,
    });
    const data = (
      prisma.verificationRecord.create.mock.calls[0] as unknown as [
        { data: Record<string, unknown> },
      ]
    )[0].data;
    expect(data).toMatchObject({
      tokens: 1100,
      inputTokens: 1000,
      outputTokens: 100,
    });
  });

  it('la entrada cuenta lo leído y escrito en caché', async () => {
    const { runtime, prisma } = build({
      input: 100,
      output: 10,
      cacheRead: 20,
      cacheWrite: 30,
      thinking: 0,
    });
    await runtime.run({
      tenantId: 't',
      botConfigId: 'b',
      conversationId: 'c',
      capability: 'payment-proof',
      image,
    });
    const data = (
      prisma.verificationRecord.create.mock.calls[0] as unknown as [
        { data: Record<string, unknown> },
      ]
    )[0].data;
    expect(data).toMatchObject({ inputTokens: 150, outputTokens: 10 });
  });

  it('si el proveedor no informa el desglose guarda NULL, no cero', async () => {
    const { runtime, prisma } = build(undefined);
    await runtime.run({
      tenantId: 't',
      botConfigId: 'b',
      conversationId: 'c',
      capability: 'payment-proof',
      image,
    });
    const data = (
      prisma.verificationRecord.create.mock.calls[0] as unknown as [
        { data: Record<string, unknown> },
      ]
    )[0].data;
    expect(data.inputTokens).toBeNull();
    expect(data.outputTokens).toBeNull();
  });

  it('dryRun no guarda, no toca el historial ni resuelve contexto', async () => {
    const { runtime, prisma, ledger, grounding, orchestrator } = build({
      input: 1000,
      output: 100,
      cacheRead: 0,
      cacheWrite: 0,
      thinking: 0,
    });
    const out = await runtime.dryRun({
      tenantId: 't',
      specialistId: 'esp-1',
      version: 2,
      capability: 'payment-proof',
      promptTemplate: 'borrador de prueba',
      rules: { version: 1, rules: [] },
      contextSources: { version: 1, sources: [] },
      image,
    });
    expect(out).toMatchObject({
      tokens: 1100,
      inputTokens: 1000,
      outputTokens: 100,
    });
    expect(out.result.verdict).toBe('VALID');
    expect(prisma.verificationRecord.create).not.toHaveBeenCalled();
    expect(prisma.botSpecialistBinding.findFirst).not.toHaveBeenCalled();
    expect(ledger.checkByHash).not.toHaveBeenCalled();
    expect(ledger.checkByFingerprint).not.toHaveBeenCalled();
    expect(grounding.resolve).not.toHaveBeenCalled();
    const call = (
      orchestrator.analyzeImageForSpecialist.mock.calls[0] as unknown as [
        string,
        { systemPrompt: string },
      ]
    )[0];
    expect(call).toBe('esp-1');
  });

  it('dryRun con reglas que necesitan contexto nunca da VALID', async () => {
    const { runtime } = build();
    const out = await runtime.dryRun({
      tenantId: 't',
      specialistId: 'esp-1',
      version: 1,
      capability: 'payment-proof',
      promptTemplate: 'x',
      rules: {
        version: 1,
        rules: [
          {
            field: 'amount',
            op: 'gte',
            ref: 'grounding.expectedAmount',
            onFail: 'INVALID',
          },
        ],
      },
      contextSources: {
        version: 1,
        sources: [
          {
            key: 'expectedAmount',
            kind: 'TOOL',
            name: 'consultar_reserva',
            valuePath: 'data.monto',
            required: true,
          },
        ],
      },
      image,
    });
    expect(out.result.verdict).not.toBe('VALID');
  });
});
