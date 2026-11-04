import { IntentAiClassifier } from 'src/bot/intent/IntentAiClassifier';
import { spaRecords } from './fixture';

const candidates = spaRecords().filter((r) => r.aiClassifiable);

function build(answers: Array<string | Error>) {
  const prompts: Array<{ system: string; user: string; max?: number }> = [];
  let i = 0;
  const ai = {
    classify: jest.fn((input: any) => {
      prompts.push({
        system: input.systemPrompt,
        user: input.userMessage,
        max: input.maxTokens,
      });
      const next = answers[Math.min(i++, answers.length - 1)];
      return next instanceof Error
        ? Promise.reject(next)
        : Promise.resolve({ content: next });
    }),
  };
  const classifier = new IntentAiClassifier(ai as never);
  (classifier as unknown as { logger: object }).logger = { warn: jest.fn() };
  return { classifier, ai, prompts };
}

const run = (
  c: IntentAiClassifier,
  text: string,
  conv = 'c1',
  last: string | null = null,
) => c.classify('bot', conv, text, text.toLowerCase(), candidates, last);

describe('IntentAiClassifier', () => {
  it('arma un prompt corto con las claves y descripciones, sin herramientas, ~10 tokens', async () => {
    const w = build(['booking']);
    const result = await run(
      w.classifier,
      'necesito arreglarme para un evento',
      'c1',
      '¿Qué día?',
    );
    expect(result).toEqual({ key: 'booking', cached: false });
    expect(w.prompts[0].max).toBeLessThanOrEqual(12);
    expect(w.prompts[0].system).toMatch(/- booking: /);
    expect(w.prompts[0].system).toMatch(/- treatment_question: /);
    expect(w.prompts[0].system).not.toMatch(/human_request|cancel_booking/);
    expect(w.prompts[0].user).toMatch(
      /Último mensaje del negocio: "¿Qué día\?"/,
    );
    expect(w.prompts[0].system.length).toBeLessThan(1500);
  });

  it('acepta la clave con comillas, mayúsculas o puntuación y "ninguna" da null', async () => {
    expect((await run(build(['"Booking".']).classifier, 'a'))?.key).toBe(
      'booking',
    );
    expect((await run(build(['ninguna']).classifier, 'b'))?.key).toBeNull();
  });

  it('cualquier respuesta fuera de la lista cuenta como ninguna', async () => {
    expect(
      (await run(build(['human_request']).classifier, 'c'))?.key,
    ).toBeNull();
    expect(
      (await run(build(['Creo que es booking porque']).classifier, 'd'))?.key,
    ).toBeNull();
    expect((await run(build(['']).classifier, 'e'))?.key).toBeNull();
  });

  it('cachea por texto normalizado, también las respuestas "ninguna"', async () => {
    const w = build(['booking', 'ninguna']);
    await run(w.classifier, 'texto uno');
    const again = await run(w.classifier, 'texto uno', 'otra-conversacion');
    expect(again).toEqual({ key: 'booking', cached: true });
    await run(w.classifier, 'texto dos');
    expect((await run(w.classifier, 'texto dos'))?.cached).toBe(true);
    expect(w.ai.classify).toHaveBeenCalledTimes(2);
  });

  it('limita las llamadas por conversación y por hora', async () => {
    const w = build(['ninguna']);
    for (let i = 0; i < 3; i++) await run(w.classifier, `texto ${i}`, 'c9');
    expect(await run(w.classifier, 'texto 4', 'c9')).toBeNull();
    expect(await run(w.classifier, 'texto 5', 'otra')).not.toBeNull();
  });

  it('si la IA falla devuelve null y no rompe el turno', async () => {
    expect(
      await run(build([new Error('sin saldo')]).classifier, 'f'),
    ).toBeNull();
  });

  it('sin candidatas no llama a la IA', async () => {
    const w = build(['booking']);
    expect(
      await w.classifier.classify('bot', 'c', 'x', 'x', [], null),
    ).toBeNull();
    expect(w.ai.classify).not.toHaveBeenCalled();
  });
});
