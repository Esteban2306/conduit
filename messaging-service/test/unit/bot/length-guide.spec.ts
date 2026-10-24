import { lengthGuide, lengthWordBudget } from 'src/bot/prompt/length-guide';
import { ContextBuilder } from 'src/bot/prompt/ContextBuilder';
import { PromptEngine } from 'src/bot/prompt/PromptEngine';
import { PromptRenderer } from 'src/bot/prompt/PromptRenderer';
import { VariableResolver } from 'src/bot/prompt/VariableResolver';

describe('lengthWordBudget', () => {
  it.each([
    [100, 40],
    [400, 94],
    [800, 120],
    [1024, 120],
    [1500, 120],
  ])('con techo de %i tokens da %i palabras', (tokens, words) => {
    expect(lengthWordBudget(tokens)).toBe(words);
  });

  it('el presupuesto en tokens siempre cabe en el techo con margen', () => {
    for (let ceiling = 300; ceiling <= 1500; ceiling += 50) {
      expect(lengthWordBudget(ceiling) * 1.7).toBeLessThanOrEqual(
        Math.max(ceiling * 0.5, 40 * 1.7),
      );
    }
  });

  it('el texto nombra el límite y pide no dejar frases a medias', () => {
    const text = lengthGuide(800);
    expect(text).toContain('máximo 120 palabras');
    expect(text).toContain('3 párrafos');
    expect(text).toContain('nunca dejes una frase a medias');
  });
});

describe('PromptEngine incluye la guía de longitud', () => {
  const engine = (settings: Record<string, unknown> | null) =>
    new PromptEngine(
      { findActive: () => Promise.resolve('Eres {{agentName}}.') } as never,
      { findByBot: () => Promise.resolve(settings) } as never,
      new VariableResolver(),
      new ContextBuilder(),
      new PromptRenderer(),
      { assemble: () => Promise.resolve({ compiled: null }) } as never,
      { resolve: () => Promise.resolve({ compiledBlock: null }) } as never,
      { get: () => 'America/Bogota' } as never,
    );
  const input = {
    userMessage: 'hola',
    history: [],
    context: {},
    summary: null,
  };

  it('va en el bloque cacheable y sigue el techo configurado', async () => {
    const built = await engine({
      maxTokensConversation: 400,
    }).buildConversationPrompt('bot', input);
    expect(built.cacheablePrompt).toContain('máximo 94 palabras');
    expect(built.dynamicPrompt).not.toContain('Límite de respuesta');
    expect(built.maxTokens).toBe(400);
  });

  it('sin ajustes usa el techo por defecto de 800', async () => {
    const built = await engine(null).buildConversationPrompt('bot', input);
    expect(built.maxTokens).toBe(800);
    expect(built.cacheablePrompt).toContain('máximo 120 palabras');
  });
});
