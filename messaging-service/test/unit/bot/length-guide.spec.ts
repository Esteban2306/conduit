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

describe('PromptEngine.buildSlimPrompt', () => {
  const engine = (knowledge: string | null) =>
    new PromptEngine(
      {
        findActive: () => Promise.resolve('PROMPT COMPLETO {{agentName}}'),
      } as never,
      {
        findByBot: () =>
          Promise.resolve({ agentName: 'Sofía', maxTokensConversation: 1024 }),
      } as never,
      new VariableResolver(),
      new ContextBuilder(),
      new PromptRenderer(),
      { assemble: () => Promise.resolve({ compiled: knowledge }) } as never,
      {
        resolve: () => Promise.resolve({ compiledBlock: 'DATOS EXTERNOS' }),
      } as never,
      { get: () => 'America/Bogota' } as never,
    );
  const input = {
    userMessage: 'quiero agendar',
    history: [],
    context: {},
    summary: 'Resumen previo',
    leadingBotMessages: ['Hola, soy Sofía'],
    hasTools: true,
  };

  it('usa las instrucciones de la intención, no el prompt completo ni los datos externos', async () => {
    const built = await engine('CONOCIMIENTO').buildSlimPrompt(
      'bot',
      { prompt: 'Gestionas citas, {{agentName}}.' },
      input,
    );
    expect(built.cacheablePrompt).toContain('Gestionas citas, Sofía.');
    expect(built.cacheablePrompt).not.toContain('PROMPT COMPLETO');
    expect(built.cacheablePrompt).not.toContain('DATOS EXTERNOS');
    expect(built.cacheablePrompt).not.toContain('CONOCIMIENTO');
  });

  it('mantiene límite de respuesta, reglas de seguridad y disciplina de herramientas', async () => {
    const built = await engine(null).buildSlimPrompt(
      'bot',
      { prompt: 'x' },
      input,
    );
    expect(built.cacheablePrompt).toContain('Límite de respuesta');
    expect(built.cacheablePrompt).toContain('Reglas de seguridad');
    expect(built.cacheablePrompt).toContain(
      'resultado real que esa herramienta devolvió',
    );
  });

  it('conserva el hilo: fecha, resumen y últimos mensajes van en el bloque dinámico', async () => {
    const built = await engine(null).buildSlimPrompt(
      'bot',
      { prompt: 'x' },
      input,
    );
    expect(built.dynamicPrompt).toMatch(/Resumen previo/);
    expect(built.dynamicPrompt).toMatch(/Hola, soy Sofía/);
    expect(built.dynamicPrompt).toMatch(/Hoy es|fecha/i);
  });

  it('incluye el conocimiento solo si la intención lo pide y respeta su tope de salida', async () => {
    const built = await engine('CONOCIMIENTO').buildSlimPrompt(
      'bot',
      { prompt: 'x', includeKnowledge: true, maxTokens: 400 },
      input,
    );
    expect(built.cacheablePrompt).toContain('CONOCIMIENTO');
    expect(built.maxTokens).toBe(400);
  });

  it('es más corto que el prompt completo con el mismo conocimiento', async () => {
    const e = engine('K'.repeat(2000));
    const slim = await e.buildSlimPrompt('bot', { prompt: 'x' }, input);
    const full = await e.buildConversationPrompt('bot', input);
    expect(slim.cacheablePrompt!.length).toBeLessThan(
      full.cacheablePrompt!.length,
    );
  });
});
