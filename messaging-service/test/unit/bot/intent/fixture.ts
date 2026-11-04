import { readFileSync } from 'fs';
import { join } from 'path';
import { BotIntentSet } from 'src/bot/intent/IntentRepository.service';
import { compileIntent } from 'src/bot/intent/IntentResolver';
import { IntentModeValue, IntentRecord } from 'src/bot/intent/intent-types';

/**
 * Catálogo de un spa de ejemplo. Es una copia de
 * leonice_spa_backend/src/conduit/intents/conduit-intent-catalog.ts: Conduit
 * no importa nada del negocio, así que sus pruebas usan esta foto.
 */
export const SPA_SEEDS: any[] = JSON.parse(
  readFileSync(join(__dirname, '../../../fixtures/spa-intents.json'), 'utf8'),
);

export function toRecord(
  seed: any,
  mode: IntentModeValue = 'ACTIVE',
): IntentRecord {
  return {
    id: `id-${seed.key}`,
    key: seed.key,
    name: seed.name,
    description: seed.description ?? '',
    handler: seed.handler,
    mode: seed.lockedMode ?? mode,
    priority: seed.priority ?? 100,
    patterns: seed.patterns ?? [],
    denyPatterns: seed.denyPatterns ?? [],
    maxTokens: seed.maxTokens ?? 12,
    respectsOpenFlow: seed.respectsOpenFlow ?? false,
    allowsQuestion: seed.allowsQuestion ?? true,
    negationOk: seed.negationOk ?? false,
    fixedConfidence: seed.fixedConfidence ?? null,
    aiClassifiable: seed.aiClassifiable ?? false,
    config: seed.config ?? {},
    variants: seed.variants ?? {},
    cooldownSeconds: seed.cooldownSeconds ?? 0,
    schedule: seed.schedule ?? null,
    notes: seed.notes ?? null,
    version: 1,
  };
}

export function spaRecords(
  mode: IntentModeValue | Record<string, IntentModeValue> = 'ACTIVE',
): IntentRecord[] {
  return SPA_SEEDS.map((seed) =>
    toRecord(
      seed,
      typeof mode === 'string' ? mode : (mode[seed.key] ?? 'ACTIVE'),
    ),
  ).sort((a, b) => a.priority - b.priority);
}

export function intentSet(records: IntentRecord[]): BotIntentSet {
  const byKey = new Map(records.map((r) => [r.key, r]));
  return {
    all: records,
    compiled: records.filter((r) => r.mode !== 'OFF').map(compileIntent),
    byKey,
    agent: 'Sofía',
    business: 'Leonice Spa',
    modeOf: (key) => byKey.get(key)?.mode ?? 'SHADOW',
  };
}

export const TIME_ZONE = 'America/Bogota';
