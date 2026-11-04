const TOKENS_PER_SPANISH_WORD = 1.7;
const SHARE_OF_CEILING = 0.4;
const MIN_WORDS = 40;
const MAX_WORDS = 120;

export function lengthWordBudget(maxTokens: number): number {
  const words = Math.floor(
    (maxTokens * SHARE_OF_CEILING) / TOKENS_PER_SPANISH_WORD,
  );
  return Math.min(MAX_WORDS, Math.max(MIN_WORDS, words));
}

export function lengthGuide(maxTokens: number): string {
  return (
    `Límite de respuesta: máximo ${lengthWordBudget(maxTokens)} palabras en como mucho 3 párrafos cortos. ` +
    'Si hay más por decir, da lo esencial y ofrece seguir en otro mensaje; nunca dejes una frase a medias.'
  );
}
