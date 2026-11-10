import { promises as fs } from 'fs';
import { DryRunInput, DryRunOutcome } from '../SpecialistRuntime';
import { outputSchemaDocumentSchema } from '../contracts';
import { ModelPrice, estimateCostUsd } from '../pricing';
import { EvalCase, bankFingerprint, sha256 } from './eval-case';
import {
  CaseResult,
  EvalSummary,
  scoreCase,
  skippedCase,
  summarize,
} from './eval-scoring';

export const RESULT_VERSION = 1;
export const DEFAULT_MAX_COST_USD = 0.5;
export const DEFAULT_MAX_TOKENS = 300_000;

export interface EvalSpecialist {
  id: string;
  key: string;
  version: number;
  capability: string;
  promptTemplate: string;
  outputSchema: unknown;
  rules: unknown;
  contextSources: unknown;
}

export interface EvalRunOptions {
  tenantId: string;
  specialist: EvalSpecialist;
  draftUsed: {
    promptTemplate: boolean;
    outputSchema: boolean;
    rules: boolean;
    contextSources: boolean;
  };
  cases: EvalCase[];
  prices: Record<string, ModelPrice>;
  maxCostUsd: number;
  maxTokens: number;
  dryRun: (input: DryRunInput) => Promise<DryRunOutcome>;
  onProgress?: (done: number, total: number, result: CaseResult) => void;
  now?: () => Date;
}

export interface EvalRunResult {
  version: typeof RESULT_VERSION;
  createdAt: string;
  specialist: { id: string; key: string; version: number; capability: string };
  definitionSha256: string;
  draftUsed: EvalRunOptions['draftUsed'];
  bankSha256: string;
  models: string[];
  limits: { maxCostUsd: number; maxTokens: number };
  stoppedByBudget: boolean;
  summary: EvalSummary;
  cases: CaseResult[];
}

export async function runEvaluation(
  options: EvalRunOptions,
): Promise<EvalRunResult> {
  const { specialist } = options;
  const schema = outputSchemaDocumentSchema.parse(specialist.outputSchema);
  const results: CaseResult[] = [];
  const bankEntries: Array<{
    id: string;
    imageSha256: string;
    expected: EvalCase['expected'];
  }> = [];
  let spent = 0;
  let tokens = 0;
  let stopped = false;

  for (const item of options.cases) {
    const image = await fs.readFile(item.imagePath);
    const base = {
      id: item.id,
      imageSha256: sha256(image),
      expected: item.expected,
    };
    bankEntries.push(base);

    if (stopped || spent >= options.maxCostUsd || tokens >= options.maxTokens) {
      stopped = true;
      const skipped = skippedCase(base);
      results.push(skipped);
      options.onProgress?.(results.length, options.cases.length, skipped);
      continue;
    }

    const outcome = await options.dryRun({
      tenantId: options.tenantId,
      specialistId: specialist.id,
      version: specialist.version,
      capability: specialist.capability,
      promptTemplate: specialist.promptTemplate,
      outputSchema: specialist.outputSchema,
      rules: specialist.rules,
      contextSources: specialist.contextSources,
      image,
    });

    const costUsd = estimateCostUsd(
      options.prices,
      outcome.modelUsed,
      outcome.inputTokens,
      outcome.outputTokens,
    );
    spent += costUsd ?? 0;
    tokens += outcome.tokens;

    const scored = scoreCase(base, schema, {
      actual: {
        verdict: outcome.result.verdict,
        confidence: outcome.result.confidence,
        fields: outcome.result.fields,
        reasonCodes: outcome.result.reasonCodes,
      },
      tokens: {
        input: outcome.inputTokens,
        output: outcome.outputTokens,
        total: outcome.tokens,
      },
      latencyMs: outcome.latencyMs,
      modelUsed: outcome.modelUsed,
      costUsd,
    });
    results.push(scored);
    options.onProgress?.(results.length, options.cases.length, scored);
  }

  return {
    version: RESULT_VERSION,
    createdAt: (options.now?.() ?? new Date()).toISOString(),
    specialist: {
      id: specialist.id,
      key: specialist.key,
      version: specialist.version,
      capability: specialist.capability,
    },
    definitionSha256: sha256(
      JSON.stringify([
        specialist.promptTemplate,
        specialist.outputSchema,
        specialist.rules,
        specialist.contextSources,
      ]),
    ),
    draftUsed: options.draftUsed,
    bankSha256: bankFingerprint(bankEntries),
    models: [
      ...new Set(
        results.map((r) => r.modelUsed).filter((m): m is string => m !== null),
      ),
    ].sort(),
    limits: { maxCostUsd: options.maxCostUsd, maxTokens: options.maxTokens },
    stoppedByBudget: stopped,
    summary: summarize(results),
    cases: results,
  };
}
