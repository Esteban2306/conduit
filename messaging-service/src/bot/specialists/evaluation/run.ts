import { promises as fs } from 'fs';
import path from 'path';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import { AiErrorClassifier } from '../../ai/AiErrorClassifier';
import { AiModelSelectorService } from '../../ai/AiModelSelectorService';
import { AiOrchestrator } from '../../ai/AiOrchestrator';
import { AiProviderFactory } from '../../ai/AiProviderFactory';
import { AnthropicProvider } from '../../ai/providers/AnthropicProvider';
import { CustomProvider } from '../../ai/providers/CustomProvider';
import { GeminiProvider } from '../../ai/providers/GeminiProvider';
import { GroqProvider } from '../../ai/providers/GroqProvider';
import { MistralProvider } from '../../ai/providers/MistralProvider';
import { OpenAIProvider } from '../../ai/providers/OpenAIProvider';
import { OpenRouterProvider } from '../../ai/providers/OpenRouterProvider';
import { configFactory } from 'src/config';
import { SecretEncryptionService } from 'src/shared/security/secret-encryption.service';
import { undeclaredGroundingKeys } from '../grounding-config';
import {
  contextSourcesDocumentSchema,
  rulesDocumentSchema,
} from '../contracts';
import { buildPriceTable } from '../pricing';
import { SpecialistRuntime } from '../SpecialistRuntime';
import { dryRunDraftSchema } from '../admin/specialist-verification.schemas';
import { loadBank, MAX_EVAL_CASES } from './eval-case';
import { compareRuns, parseRun } from './eval-compare';
import {
  DEFAULT_MAX_COST_USD,
  DEFAULT_MAX_TOKENS,
  EvalSpecialist,
  runEvaluation,
} from './eval-run';
import { formatComparison, formatRun } from './eval-report';

const USAGE = `Uso:
  npm run specialists:eval -- run --dir=<carpeta> --tenant=<id> --specialist=<clave|id> [opciones]
  npm run specialists:eval -- compare --a=<resultado.json> --b=<resultado.json> [--json] [--fail-on-regression]

run valida el banco y el especialista SIN gastar nada. Para llamar al modelo (gasta tokens reales) agrega --yes.
Opciones de run:
  --draft=<archivo.json>   prueba un borrador de promptTemplate, rules y/o contextSources sin guardarlo
  --out=<archivo.json>     dónde guardar el resultado (por defecto eval-<clave>-<fecha>.json)
  --max-cases=<n>          máximo de casos (por defecto ${MAX_EVAL_CASES})
  --max-cost-usd=<n>       tope de costo estimado (por defecto ${DEFAULT_MAX_COST_USD})
  --max-tokens=<n>         tope de tokens (por defecto ${DEFAULT_MAX_TOKENS})

Carpeta del banco: por cada <caso>.jpg|png|webp debe existir <caso>.expected.json con
{"verdict":"VALID|INVALID|NEEDS_REVIEW|ERROR","fields":{"amount":150000,"reference":"..."}}.
Las imágenes nunca se guardan en la base ni en el resultado.`;

function option(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv
    .find((arg) => arg.startsWith(prefix))
    ?.slice(prefix.length);
}

const flag = (name: string): boolean => process.argv.includes(`--${name}`);

function positiveNumber(name: string, fallback: number): number {
  const raw = option(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`--${name} debe ser un número positivo`);
  }
  return value;
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
}

async function compareCommand(): Promise<void> {
  const a = option('a');
  const b = option('b');
  if (!a || !b) throw new Error('Indica --a y --b');
  const comparison = compareRuns(
    parseRun(await readJson(a)),
    parseRun(await readJson(b)),
  );
  console.log(
    flag('json')
      ? JSON.stringify(comparison, null, 2)
      : formatComparison(comparison),
  );
  if (flag('fail-on-regression') && comparison.worse) process.exitCode = 2;
}

async function runCommand(): Promise<void> {
  const dir = option('dir');
  const tenantId = option('tenant');
  const specialistRef = option('specialist');
  if (!dir || !tenantId || !specialistRef) {
    throw new Error('Indica --dir, --tenant y --specialist');
  }
  const maxCases = positiveNumber('max-cases', MAX_EVAL_CASES);
  const maxCostUsd = positiveNumber('max-cost-usd', DEFAULT_MAX_COST_USD);
  const maxTokens = positiveNumber('max-tokens', DEFAULT_MAX_TOKENS);

  const bank = await loadBank(dir, maxCases);
  if (bank.problems.length > 0) {
    console.error('El banco tiene problemas y no se ejecutó nada:');
    for (const problem of bank.problems) {
      console.error(`  ${problem.file}: ${problem.message}`);
    }
    process.exitCode = 1;
    return;
  }

  const databaseName = (() => {
    try {
      return new URL(process.env.DATABASE_URL ?? '').pathname.slice(1);
    } catch {
      return '(desconocida)';
    }
  })();

  const prisma = new PrismaClient();
  try {
    const row = await prisma.specialist.findFirst({
      where: {
        tenantId,
        archivedAt: null,
        OR: [{ id: specialistRef }, { key: specialistRef }],
      },
      select: {
        id: true,
        key: true,
        version: true,
        capability: true,
        promptTemplate: true,
        rules: true,
        contextSources: true,
      },
    });
    if (!row) throw new Error('Especialista no encontrado en ese tenant');

    let specialist: EvalSpecialist = row;
    const draftUsed = {
      promptTemplate: false,
      rules: false,
      contextSources: false,
    };
    const draftFile = option('draft');
    if (draftFile) {
      const parsed = dryRunDraftSchema.safeParse(await readJson(draftFile));
      if (!parsed.success) {
        throw new Error(
          `Borrador inválido: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
        );
      }
      specialist = {
        ...row,
        promptTemplate: parsed.data.promptTemplate ?? row.promptTemplate,
        rules: parsed.data.rules ?? row.rules,
        contextSources: parsed.data.contextSources ?? row.contextSources,
      };
      draftUsed.promptTemplate = parsed.data.promptTemplate !== undefined;
      draftUsed.rules = parsed.data.rules !== undefined;
      draftUsed.contextSources = parsed.data.contextSources !== undefined;
    }

    const rules = rulesDocumentSchema.safeParse(specialist.rules);
    const sources = contextSourcesDocumentSchema.safeParse(
      specialist.contextSources,
    );
    if (!rules.success || !sources.success) {
      throw new Error('Las reglas o las fuentes de contexto no son válidas');
    }
    const undeclared = undeclaredGroundingKeys(
      rules.data,
      sources.data.sources,
    );
    if (undeclared.length > 0) {
      throw new Error(
        `Las reglas usan claves de contexto sin declarar: ${undeclared.join(', ')}`,
      );
    }

    const models = await prisma.aiModelConfig.findMany({
      where: {
        specialistId: specialist.id,
        role: 'IMAGE_ANALYSIS',
        isActive: true,
      },
      select: { provider: true, model: true },
    });

    console.log(
      `Base: ${databaseName} | tenant: ${tenantId} | especialista: ${specialist.key} v${specialist.version}`,
    );
    console.log(
      `Banco: ${bank.cases.length} caso(s) | modelos activos del especialista: ${models.map((m) => `${m.provider}/${m.model}`).join(', ') || '(ninguno)'}`,
    );
    console.log(
      `Topes: ${maxCostUsd} USD y ${maxTokens} tokens (la corrida se detiene al alcanzar cualquiera)`,
    );

    if (!flag('yes')) {
      console.log(
        '\nValidación terminada SIN llamar al modelo. Agrega --yes para ejecutar la evaluación (gasta tokens reales).',
      );
      return;
    }

    if (models.length === 0) {
      throw new Error(
        'El especialista no tiene modelos activos de análisis de imágenes: no hay nada que evaluar',
      );
    }

    const config = new ConfigService(configFactory());
    const encryption = new SecretEncryptionService(config);
    encryption.onModuleInit();
    const selector = new AiModelSelectorService(
      prisma as never,
      config,
      encryption,
    );
    const providers = new AiProviderFactory(
      new AnthropicProvider(),
      new OpenAIProvider(),
      new GeminiProvider(),
      new GroqProvider(),
      new MistralProvider(),
      new CustomProvider(),
      new OpenRouterProvider(),
    );
    const orchestrator = new AiOrchestrator(
      selector,
      providers,
      new AiErrorClassifier(),
      { notifyAiCredentialInvalid: () => Promise.resolve(false) } as never,
    );
    const runtime = new SpecialistRuntime(
      config,
      prisma as never,
      orchestrator,
      { publish: () => undefined } as never,
      {} as never,
      {} as never,
    );

    const result = await runEvaluation({
      tenantId,
      specialist,
      draftUsed,
      cases: bank.cases,
      prices: buildPriceTable(process.env.SPECIALISTS_PRICE_TABLE),
      maxCostUsd,
      maxTokens,
      dryRun: (input) => runtime.dryRun(input),
      onProgress: (done, total, r) =>
        console.log(
          `  [${done}/${total}] ${r.id}: ${r.status === 'DONE' ? `${r.actual!.verdict} (esperado ${r.expected.verdict})` : 'omitido por presupuesto'}`,
        ),
    });

    const out =
      option('out') ??
      path.join(
        process.cwd(),
        `eval-${specialist.key}-${result.createdAt.replace(/[:.]/g, '-')}.json`,
      );
    await fs.writeFile(out, JSON.stringify(result, null, 2), { mode: 0o600 });
    console.log(`\n${formatRun(result)}\n\nResultado guardado en ${out}`);
  } finally {
    await prisma.$disconnect();
  }
}

async function main(): Promise<void> {
  const command = process.argv[2];
  try {
    if (command === 'run') await runCommand();
    else if (command === 'compare') await compareCommand();
    else {
      console.log(USAGE);
      process.exitCode = command ? 1 : 0;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

void main();
