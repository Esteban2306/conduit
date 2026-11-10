export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
}

export const DEFAULT_PRICE_TABLE: Readonly<Record<string, ModelPrice>> = {
  'claude-haiku': { inputPerMTok: 1, outputPerMTok: 5 },
  'claude-sonnet': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-opus': { inputPerMTok: 5, outputPerMTok: 25 },
};

const isPrice = (value: unknown): value is ModelPrice => {
  if (typeof value !== 'object' || value === null) return false;
  const { inputPerMTok, outputPerMTok } = value as Record<string, unknown>;
  return (
    typeof inputPerMTok === 'number' &&
    typeof outputPerMTok === 'number' &&
    Number.isFinite(inputPerMTok) &&
    Number.isFinite(outputPerMTok) &&
    inputPerMTok >= 0 &&
    outputPerMTok >= 0
  );
};

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

export function buildPriceTable(
  override: string | undefined,
): Record<string, ModelPrice> {
  const table: Record<string, ModelPrice> = { ...DEFAULT_PRICE_TABLE };
  if (!override?.trim()) return table;
  const parsed = parseJson(override);
  if (typeof parsed !== 'object' || parsed === null) return table;
  for (const [prefix, price] of Object.entries(parsed)) {
    if (prefix && isPrice(price)) table[prefix] = price;
  }
  return table;
}

export function priceFor(
  table: Record<string, ModelPrice>,
  model: string | null | undefined,
): ModelPrice | null {
  if (!model) return null;
  let best: string | null = null;
  for (const prefix of Object.keys(table)) {
    if (model.startsWith(prefix) && (!best || prefix.length > best.length)) {
      best = prefix;
    }
  }
  return best ? table[best] : null;
}

export function estimateCostUsd(
  table: Record<string, ModelPrice>,
  model: string | null | undefined,
  inputTokens: number | null | undefined,
  outputTokens: number | null | undefined,
): number | null {
  const price = priceFor(table, model);
  if (!price || inputTokens == null || outputTokens == null) return null;
  const cost =
    (inputTokens * price.inputPerMTok + outputTokens * price.outputPerMTok) /
    1_000_000;
  return Math.round(cost * 1e6) / 1e6;
}
