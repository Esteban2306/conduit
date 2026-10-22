const create = jest.fn();
const constructed: Array<Record<string, unknown>> = [];
jest.mock('@anthropic-ai/sdk', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation((options: Record<string, unknown>) => {
    constructed.push(options);
    return { messages: { create } };
  }),
}));

import { ReasoningMode } from '@prisma/client';
import {
  AnthropicProvider,
  billableTokens,
} from 'src/bot/ai/providers/AnthropicProvider';
import { PromptEngine } from 'src/bot/prompt/PromptEngine';
import { VariableResolver } from 'src/bot/prompt/VariableResolver';
import { ContextBuilder } from 'src/bot/prompt/ContextBuilder';
import { PromptRenderer } from 'src/bot/prompt/PromptRenderer';
import {
  promptIsoDate,
  promptNow,
  promptToday,
} from 'src/bot/prompt/prompt-clock';

const usage = (
  input: number,
  output: number,
  cacheRead = 0,
  cacheWrite = 0,
  thinking = 0,
) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheWrite,
  output_tokens_details: { thinking_tokens: thinking },
});

const TOOLS = [
  { name: 'uno', description: 'd1', parametersSchema: { type: 'object' } },
  { name: 'dos', description: 'd2', parametersSchema: { type: 'object' } },
];

describe('AnthropicProvider: caché, razonamiento y tiempos', () => {
  beforeEach(() => {
    create.mockReset();
    constructed.length = 0;
  });

  it('marca como cacheables el bloque fijo del system y la última herramienta, nunca el dinámico', async () => {
    create.mockResolvedValue({
      content: [{ type: 'text', text: 'hola' }],
      usage: usage(100, 10),
      stop_reason: 'end_turn',
      model: 'm',
    });
    await new AnthropicProvider().generateText({
      prompt: 'hola',
      systemPrompt: 'FIJO\n\nDINAMICO',
      systemBlocks: { cacheable: 'FIJO', dynamic: 'DINAMICO' },
      model: 'm',
      apiKey: 'k',
      baseUrl: '',
      tools: TOOLS,
    });
    const params = create.mock.calls[0][0];
    expect(params.system).toEqual([
      { type: 'text', text: 'FIJO', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'DINAMICO' },
    ]);
    expect(params.tools[0].cache_control).toBeUndefined();
    expect(params.tools[1].cache_control).toEqual({ type: 'ephemeral' });
    expect(params.temperature).toBeUndefined();
    expect(constructed[0]).toMatchObject({ timeout: 30_000, maxRetries: 1 });
  });

  it('sin bloques conserva el system como texto y no agrega caché', async () => {
    create.mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      usage: usage(10, 1),
      stop_reason: 'end_turn',
      model: 'm',
    });
    await new AnthropicProvider().generateText({
      prompt: 'x',
      systemPrompt: 'TODO',
      model: 'm',
      apiKey: 'k',
      baseUrl: '',
      tools: TOOLS,
    });
    const params = create.mock.calls[0][0];
    expect(params.system).toBe('TODO');
    expect(params.tools[1].cache_control).toBeUndefined();
  });

  it.each([
    ['OFF', { thinking: { type: 'disabled' } }],
    ['LOW', { output_config: { effort: 'low' } }],
    ['AUTO', {}],
  ] as const)('razonamiento %s se traduce a la API', async (mode, expected) => {
    create.mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      usage: usage(10, 1),
      stop_reason: 'end_turn',
      model: 'm',
    });
    await new AnthropicProvider().generateText({
      prompt: 'x',
      systemPrompt: 's',
      model: 'm',
      apiKey: 'k',
      baseUrl: '',
      reasoningMode: mode,
    });
    const params = create.mock.calls[0][0];
    expect({
      ...(params.thinking ? { thinking: params.thinking } : {}),
      ...(params.output_config ? { output_config: params.output_config } : {}),
    }).toEqual(expected);
  });

  it('suma el uso de todas las vueltas del ciclo de herramientas y cuenta la caché al 10 %', async () => {
    create
      .mockResolvedValueOnce({
        content: [{ type: 'tool_use', id: 't1', name: 'uno', input: {} }],
        usage: usage(1000, 50, 4000, 0, 30),
        stop_reason: 'tool_use',
        model: 'm',
      })
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'listo' }],
        usage: usage(1500, 80, 4000, 0, 0),
        stop_reason: 'end_turn',
        model: 'm',
      });
    const result = await new AnthropicProvider().generateText({
      prompt: 'x',
      systemPrompt: 's',
      model: 'm',
      apiKey: 'k',
      baseUrl: '',
      tools: TOOLS,
      toolExecutor: () => Promise.resolve({ ok: true, content: {} }),
    });
    expect(result.usage).toEqual({
      input: 2500,
      output: 130,
      cacheRead: 8000,
      cacheWrite: 0,
      thinking: 30,
    });
    expect(result.tokensUsed).toBe(2500 + 800 + 130);
    expect(result.stopReason).toBe('end_turn');
  });

  it('billableTokens cobra escritura de caché completa y lectura al 10 %', () => {
    expect(
      billableTokens({
        input: 100,
        output: 20,
        cacheRead: 1001,
        cacheWrite: 300,
        thinking: 5,
      }),
    ).toBe(100 + 300 + 101 + 20);
  });
});

describe('PromptEngine: bloque cacheable sin datos de la conversación', () => {
  function engine(settings: Record<string, unknown> | null) {
    return new PromptEngine(
      {
        findActive: () =>
          Promise.resolve('Eres {{agentName}}. Hoy: {{today}}.'),
      } as never,
      { findByBot: () => Promise.resolve(settings) } as never,
      new VariableResolver(),
      new ContextBuilder(),
      new PromptRenderer(),
      { assemble: () => Promise.resolve({ compiled: null }) } as never,
      {
        resolve: () =>
          Promise.resolve({
            compiledBlock: 'Datos del negocio:\nnegocio:\n  anticipo: 50',
          }),
      } as never,
      { get: () => 'America/Bogota' } as never,
    );
  }

  it('el resumen, la memoria y la hora quedan solo en el bloque dinámico', async () => {
    const built = await engine({
      agentName: 'Lu',
      maxTokensConversation: 1024,
      reasoningMode: ReasoningMode.OFF,
    }).buildConversationPrompt('bot', {
      userMessage: 'hola',
      history: [],
      context: {
        memoriaAcciones: [
          {
            herramienta: 'x',
            parametros: '{}',
            estado: 'SUCCESS',
            resultado: 'r',
            en: 'hoy',
          },
        ],
      },
      summary: 'Quiere alisado el viernes',
      hasTools: true,
    });

    expect(built.cacheablePrompt).toContain('Eres Lu.');
    expect(built.cacheablePrompt).toContain('Datos del negocio');
    expect(built.cacheablePrompt).not.toContain('alisado el viernes');
    expect(built.cacheablePrompt).not.toContain('Fecha y hora actual');
    expect(built.dynamicPrompt).toContain('Fecha y hora actual');
    expect(built.dynamicPrompt).toContain('alisado el viernes');
    expect(built.dynamicPrompt).toContain('Acciones ya realizadas');
    expect(built.systemPrompt).toBe(
      `${built.cacheablePrompt}\n\n${built.dynamicPrompt}`,
    );
    expect(built.maxTokens).toBe(1024);
    expect(built.reasoningMode).toBe(ReasoningMode.OFF);
  });

  it('sin ajustes conserva el comportamiento anterior (razonamiento AUTO, 400 tokens)', async () => {
    const built = await engine(null).buildConversationPrompt('bot', {
      userMessage: 'hola',
      history: [],
      context: {},
      summary: null,
    });
    expect(built.reasoningMode).toBe(ReasoningMode.AUTO);
    expect(built.maxTokens).toBe(400);
  });
});

describe('prompt-clock', () => {
  const lateNightUtc = new Date('2026-10-22T01:30:00Z');

  it('usa la fecha de Bogotá aunque el servidor ya esté en el día siguiente (UTC)', () => {
    expect(promptToday('America/Bogota', lateNightUtc)).toBe(
      'miércoles, 21 de octubre de 2026',
    );
    expect(promptIsoDate('America/Bogota', lateNightUtc)).toBe('2026-10-21');
    expect(promptNow('America/Bogota', lateNightUtc)).toMatch(
      /^miércoles, 21 de octubre de 2026.*8:30.*\(2026-10-21, hora de America\/Bogota\)$/,
    );
  });
});
