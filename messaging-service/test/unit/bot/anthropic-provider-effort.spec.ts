import { randomBytes } from 'crypto';

const create = jest.fn();
jest.mock('@anthropic-ai/sdk', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ messages: { create } })),
}));

import {
  AnthropicProvider,
  supportsEffort,
} from 'src/bot/ai/providers/AnthropicProvider';

const analyze = async (model: string, effort?: 'low') => {
  create.mockResolvedValue({
    content: [{ type: 'text', text: '{}' }],
    usage: { input_tokens: 10, output_tokens: 5 },
    model,
  });
  await new AnthropicProvider().analyzeImage({
    prompt: 'p',
    systemPrompt: 's',
    imageBuffer: randomBytes(16),
    mimeType: 'image/jpeg',
    model,
    apiKey: `sk-ant-${'x'.repeat(30)}`,
    maxTokens: 1024,
    effort,
  });
  return (create.mock.calls.at(-1) as unknown as [Record<string, unknown>])[0];
};

describe('supportsEffort', () => {
  it.each([
    'claude-haiku-5-5',
    'claude-sonnet-5-5',
    'claude-sonnet-5',
    'claude-opus-5-5',
    'claude-opus-5',
    'claude-fable-5-1',
    'claude-fable-5',
    'claude-mythos-5-1',
  ])('%s sí', (model) => expect(supportsEffort(model)).toBe(true));

  it.each([
    'claude-haiku-4-5',
    'claude-sonnet-4-6',
    'claude-opus-4-8',
    'claude-opus-4-5',
    'claude-3-5-sonnet',
    'claude-haiku-50',
    'gpt-5',
    'claude-opus-5x',
    '',
  ])('%s no', (model) => expect(supportsEffort(model)).toBe(false));
});

describe('AnthropicProvider.analyzeImage: esfuerzo de razonamiento', () => {
  beforeEach(() => create.mockReset());

  it('con effort low y un modelo 5.x envía el esfuerzo bajo', async () => {
    const body = await analyze('claude-haiku-5-5', 'low');
    expect(body.output_config).toEqual({ effort: 'low' });
  });

  it.each(['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-8'])(
    'con %s no envía el parámetro',
    async (model) => {
      const body = await analyze(model, 'low');
      expect(body).not.toHaveProperty('output_config');
    },
  );

  it('sin effort no cambia la petición actual', async () => {
    const body = await analyze('claude-haiku-5-5');
    expect(body).not.toHaveProperty('output_config');
    expect(body).not.toHaveProperty('thinking');
  });

  it('no envía temperatura ni desactiva el razonamiento (400 en modelos 5.x)', async () => {
    const body = await analyze('claude-sonnet-5-5', 'low');
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('thinking');
  });

  it('conserva modelo, tope de salida, sistema e imagen', async () => {
    const body = await analyze('claude-haiku-5-5', 'low');
    expect(body).toMatchObject({
      model: 'claude-haiku-5-5',
      max_tokens: 1024,
      system: 's',
    });
  });
});
