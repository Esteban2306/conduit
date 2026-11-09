import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/shared/prisma.service';
import { AiOrchestrator } from '../ai/AiOrchestrator';
import { BudgetExceededError, TurnBudget } from '../ai/turn-budget';
import { ImageOptimizer } from '../helper/ImageOptimizer';
import { EventBusService } from 'src/infra/events/event.service';
import { EVENT_TYPES } from 'src/infra/events/constants/event.types';
import { maskSecrets } from 'src/shared/security/mask-secrets';
import {
  EMPTY_OUTPUT_SCHEMA,
  OutputSchemaDocument,
  Variables,
  MAX_REASON_CODES,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  VERDICT_VERSION,
  contextSourcesDocumentSchema,
  Verdict,
  VerificationResult,
  outputSchemaDocumentSchema,
  sanitizeVariables,
  validateRulesAgainst,
  rulesDocumentSchema,
  verificationResultSchema,
} from './contracts';
import {
  EXTRACTION_USER_PROMPT,
  buildSystemPrompt,
  parseExtraction,
} from './extraction-prompt';
import { decideVerdict, summarize } from './verdict-policy';
import { variablesFingerprint } from './fingerprint';
import { exposedVariables } from './facts';
import { ImageHash, hashImage } from './image-hash';
import { GroundingOutcome, GroundingResolver } from './GroundingResolver';
import {
  referencedGroundingKeys,
  undeclaredGroundingKeys,
} from './grounding-config';
import { ReuseFinding, VerificationLedger } from './VerificationLedger';

const MAX_OUTPUT_TOKENS = 1024;
const DRY_RUN_TIMEOUT_MS = 20_000;
const DAY_MS = 86_400_000;

export interface LegacyImageVerdict {
  valid: boolean;
  confidence: string;
}

export interface SpecialistRunInput {
  tenantId: string;
  botConfigId: string;
  conversationId: string;
  capability: string;
  image: Buffer;
  legacy?: LegacyImageVerdict | Promise<LegacyImageVerdict | undefined>;
  contactAddress?: string;
}

export interface DryRunInput {
  tenantId: string;
  specialistId: string;
  version: number;
  capability: string;
  promptTemplate: string;
  outputSchema: unknown;
  rules: unknown;
  contextSources: unknown;
  image: Buffer;
}

export interface DryRunOutcome {
  result: VerificationResult;
  modelUsed: string | null;
  tokens: number;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
}

export type SpecialistSkipReason =
  | 'DISABLED'
  | 'NO_BINDING'
  | 'BINDING_OFF'
  | 'SPECIALIST_INACTIVE'
  | 'LOOKUP_FAILED';

export type SpecialistRunOutcome =
  | { executed: false; reason: SpecialistSkipReason }
  | {
      executed: true;
      mode: 'SHADOW' | 'ACTIVE';
      specialistId: string;
      result: VerificationResult;
      recordId: string | null;
      onFailure: 'DEGRADE' | 'BLOCK';
      blockMessage: string | null;
      exposedVariables: Record<string, string | number | boolean>;
      validUntil: string;
      reuse?: 'CACHED' | 'ALREADY_USED' | 'OTHER_CONTACT' | 'RESENT';
    };

interface ResolvedBinding {
  mode: 'OFF' | 'SHADOW' | 'ACTIVE';
  timeoutMs: number;
  onFailure: 'DEGRADE' | 'BLOCK';
  blockMessage: string | null;
  specialist: {
    id: string;
    status: 'ACTIVE' | 'INACTIVE';
    version: number;
    promptTemplate: string;
    outputSchema: unknown;
    rules: unknown;
    contextSources: unknown;
  };
}

@Injectable()
export class SpecialistRuntime {
  private readonly logger = new Logger(SpecialistRuntime.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly orchestrator: AiOrchestrator,
    private readonly eventBus: EventBusService,
    private readonly ledger: VerificationLedger,
    private readonly grounding: GroundingResolver,
  ) {}

  isEnabled(): boolean {
    return this.config.get<boolean>('specialists.enabled') === true;
  }

  async findMode(
    tenantId: string,
    botConfigId: string,
    capability: string,
  ): Promise<'OFF' | 'SHADOW' | 'ACTIVE'> {
    if (!this.isEnabled()) return 'OFF';
    try {
      const binding = await this.lookup(tenantId, botConfigId, capability);
      if (!binding || binding.specialist.status !== 'ACTIVE') return 'OFF';
      return binding.mode;
    } catch {
      return 'OFF';
    }
  }

  async run(input: SpecialistRunInput): Promise<SpecialistRunOutcome> {
    if (!this.isEnabled()) return { executed: false, reason: 'DISABLED' };

    let binding: ResolvedBinding | null;
    try {
      binding = await this.lookup(
        input.tenantId,
        input.botConfigId,
        input.capability,
      );
    } catch (error) {
      this.logger.error(
        `No se pudo leer el vínculo del especialista: ${this.describe(error)}`,
      );
      return { executed: false, reason: 'LOOKUP_FAILED' };
    }

    if (!binding) return { executed: false, reason: 'NO_BINDING' };
    if (binding.mode === 'OFF')
      return { executed: false, reason: 'BINDING_OFF' };
    if (binding.specialist.status !== 'ACTIVE') {
      return { executed: false, reason: 'SPECIALIST_INACTIVE' };
    }

    const startedAt = Date.now();
    const hash = await hashImage(input.image);
    const mode = binding.mode;
    const reuseQuery = {
      tenantId: input.tenantId,
      capability: input.capability,
      conversationId: input.conversationId,
    };

    if (mode === 'ACTIVE') {
      const early = await this.strongestFinding(
        reuseQuery,
        await this.safeFinding(() =>
          this.ledger.checkByHash({ ...reuseQuery, hash }),
        ),
        this.readSchema(binding.specialist.outputSchema),
      );
      if (early.kind !== 'NONE') {
        return this.finishEarly(input, binding, hash, early, startedAt);
      }
    }

    const analysis = await this.analyze(binding, input);
    const fingerprint = variablesFingerprint(analysis.schema, analysis.fields);

    let reuse: ReuseFinding['kind'] = 'NONE';
    if (mode === 'ACTIVE' && fingerprint && analysis.verdict !== 'ERROR') {
      const later = await this.safeFinding(() =>
        this.ledger.checkByFingerprint({ ...reuseQuery, fingerprint }),
      );
      reuse = later.kind;
      this.applyReuse(analysis, later);
    }

    const latencyMs = Date.now() - startedAt;
    const result = this.buildResult(analysis);
    const recordId = await this.persist(input, binding, {
      hash,
      fingerprint,
      result,
      mode,
      latencyMs,
      modelUsed: analysis.modelUsed,
      tokens: analysis.tokens,
      inputTokens: analysis.inputTokens,
      outputTokens: analysis.outputTokens,
    });

    this.publish(input, binding, result, mode, latencyMs, analysis.tokens);

    return {
      executed: true,
      mode,
      specialistId: binding.specialist.id,
      result,
      recordId,
      onFailure: binding.onFailure,
      blockMessage: binding.blockMessage,
      exposedVariables: exposedVariables(analysis.schema, analysis.fields),
      validUntil: this.validUntil(),
      ...(reuse !== 'NONE' && { reuse }),
    };
  }

  async dryRun(input: DryRunInput): Promise<DryRunOutcome> {
    const startedAt = Date.now();
    const binding: ResolvedBinding = {
      mode: 'SHADOW',
      timeoutMs: DRY_RUN_TIMEOUT_MS,
      onFailure: 'DEGRADE',
      blockMessage: null,
      specialist: {
        id: input.specialistId,
        status: 'ACTIVE',
        version: input.version,
        promptTemplate: input.promptTemplate,
        outputSchema: input.outputSchema,
        rules: input.rules,
        contextSources: input.contextSources,
      },
    };
    const analysis = await this.analyze(
      binding,
      {
        tenantId: input.tenantId,
        botConfigId: 'dry-run',
        conversationId: 'dry-run',
        capability: input.capability,
        image: input.image,
      },
      { skipGrounding: true },
    );
    const result = this.buildResult(analysis);
    return {
      result,
      modelUsed: analysis.modelUsed,
      tokens: analysis.tokens,
      inputTokens: analysis.inputTokens ?? null,
      outputTokens: analysis.outputTokens ?? null,
      latencyMs: Date.now() - startedAt,
    };
  }

  private async finishEarly(
    input: SpecialistRunInput,
    binding: ResolvedBinding,
    hash: ImageHash,
    finding: Exclude<ReuseFinding, { kind: 'NONE' }>,
    startedAt: number,
  ): Promise<SpecialistRunOutcome> {
    const { record } = finding;
    const schema = this.readSchema(binding.specialist.outputSchema);
    const fields = sanitizeVariables(record.fields, schema);

    if (finding.kind === 'CACHED') {
      const result = this.buildResult({
        verdict: record.verdict,
        reasonCodes: this.withCode(record.reasonCodes, 'RESENT_SAME_IMAGE'),
        fields,
        schema,
        confidence: record.confidence,
        modelUsed: null,
        tokens: 0,
      });
      this.publish(input, binding, result, 'ACTIVE', Date.now() - startedAt, 0);
      return {
        executed: true,
        mode: 'ACTIVE',
        specialistId: binding.specialist.id,
        result,
        recordId: record.id,
        onFailure: binding.onFailure,
        blockMessage: binding.blockMessage,
        exposedVariables: exposedVariables(schema, fields),
        validUntil: this.validUntil(record.createdAt),
        reuse: 'CACHED',
      };
    }

    const used = finding.kind === 'ALREADY_USED';
    const result = this.buildResult({
      verdict: used ? 'INVALID' : 'NEEDS_REVIEW',
      reasonCodes: [used ? 'ALREADY_USED' : 'REUSED_OTHER_CONTACT'],
      fields,
      schema,
      confidence: 0,
      modelUsed: null,
      tokens: 0,
    });
    const latencyMs = Date.now() - startedAt;
    const recordId = await this.persist(input, binding, {
      hash,
      fingerprint: variablesFingerprint(schema, fields),
      result,
      mode: 'ACTIVE',
      latencyMs,
      modelUsed: null,
      tokens: 0,
    });
    this.publish(input, binding, result, 'ACTIVE', latencyMs, 0);
    return {
      executed: true,
      mode: 'ACTIVE',
      specialistId: binding.specialist.id,
      result,
      recordId,
      onFailure: binding.onFailure,
      blockMessage: binding.blockMessage,
      exposedVariables: exposedVariables(schema, fields),
      validUntil: this.validUntil(),
      reuse: finding.kind,
    };
  }

  private async strongestFinding(
    query: { tenantId: string; capability: string; conversationId: string },
    finding: ReuseFinding,
    schema: OutputSchemaDocument,
  ): Promise<ReuseFinding> {
    if (finding.kind === 'NONE' || finding.kind === 'ALREADY_USED') {
      return finding;
    }
    const fingerprint =
      finding.record.fingerprint ??
      variablesFingerprint(
        schema,
        sanitizeVariables(finding.record.fields, schema),
      );
    if (!fingerprint) return finding;

    const byFingerprint = await this.safeFinding(() =>
      this.ledger.checkByFingerprint({ ...query, fingerprint }),
    );
    return byFingerprint.kind === 'ALREADY_USED' ? byFingerprint : finding;
  }

  private validUntil(from: Date = new Date()): string {
    return new Date(from.getTime() + this.ledger.passportTtlMs()).toISOString();
  }

  private applyReuse(analysis: Analysis, finding: ReuseFinding): void {
    if (finding.kind === 'ALREADY_USED') {
      if (analysis.verdict === 'VALID' || analysis.verdict === 'NEEDS_REVIEW') {
        analysis.verdict = 'INVALID';
      }
      analysis.reasonCodes = this.withCode(
        analysis.reasonCodes,
        'ALREADY_USED',
        true,
      );
    } else if (finding.kind === 'OTHER_CONTACT') {
      if (analysis.verdict === 'VALID') analysis.verdict = 'NEEDS_REVIEW';
      analysis.reasonCodes = this.withCode(
        analysis.reasonCodes,
        'REUSED_OTHER_CONTACT',
        true,
      );
    } else if (finding.kind === 'RESENT') {
      analysis.reasonCodes = this.withCode(
        analysis.reasonCodes,
        'RESENT_SAME_RECEIPT',
      );
    }
  }

  private withCode(codes: string[], code: string, first = false): string[] {
    if (codes.includes(code)) return codes;
    const next = first ? [code, ...codes] : [...codes, code];
    return next.slice(0, MAX_REASON_CODES);
  }

  private readSchema(raw: unknown): OutputSchemaDocument {
    const parsed = outputSchemaDocumentSchema.safeParse(raw);
    return parsed.success ? parsed.data : EMPTY_OUTPUT_SCHEMA;
  }

  private async safeFinding(
    find: () => Promise<ReuseFinding>,
  ): Promise<ReuseFinding> {
    try {
      return await find();
    } catch (error) {
      this.logger.error(
        `No se pudo consultar el historial de verificaciones: ${this.describe(error)}`,
      );
      return { kind: 'NONE' };
    }
  }

  private publish(
    input: SpecialistRunInput,
    binding: ResolvedBinding,
    result: VerificationResult,
    mode: 'SHADOW' | 'ACTIVE',
    latencyMs: number,
    tokens: number,
  ): void {
    this.eventBus.publish(EVENT_TYPES.SPECIALIST_COMPLETED, {
      tenantId: input.tenantId,
      botConfigId: input.botConfigId,
      specialistId: binding.specialist.id,
      capability: input.capability,
      verdict: result.verdict,
      mode,
      latencyMs,
      tokens,
    });
  }

  private async lookup(
    tenantId: string,
    botConfigId: string,
    capability: string,
  ): Promise<ResolvedBinding | null> {
    const row = await this.prisma.botSpecialistBinding.findFirst({
      where: { tenantId, botConfigId, capability },
      select: {
        mode: true,
        timeoutMs: true,
        onFailure: true,
        blockMessage: true,
        specialist: {
          select: {
            id: true,
            status: true,
            version: true,
            promptTemplate: true,
            outputSchema: true,
            rules: true,
            contextSources: true,
          },
        },
      },
    });
    return row;
  }

  private async analyze(
    binding: ResolvedBinding,
    input: SpecialistRunInput,
    options: { skipGrounding?: boolean } = {},
  ): Promise<Analysis> {
    const declared = outputSchemaDocumentSchema.safeParse(
      binding.specialist.outputSchema,
    );
    if (!declared.success || declared.data.variables.length === 0) {
      return failure('OUTPUT_SCHEMA_INVALID');
    }
    const schema = declared.data;

    const rules = rulesDocumentSchema.safeParse(binding.specialist.rules);
    if (!rules.success) return failure('RULES_INVALID', schema);
    if (validateRulesAgainst(schema, rules.data).length > 0) {
      return failure('RULES_INVALID', schema);
    }

    const sources = contextSourcesDocumentSchema.safeParse(
      binding.specialist.contextSources,
    );
    if (!sources.success) return failure('CONTEXT_SOURCES_INVALID', schema);

    const undeclared = undeclaredGroundingKeys(
      rules.data,
      sources.data.sources,
    );
    if (undeclared.length > 0) {
      this.logger.error(
        `El especialista ${binding.specialist.id} usa claves de contexto sin declarar: ${undeclared.join(', ')}`,
      );
      return failure('RULES_INVALID', schema);
    }

    const timeoutMs = Math.min(
      Math.max(binding.timeoutMs, MIN_TIMEOUT_MS),
      MAX_TIMEOUT_MS,
    );
    const grounding: Promise<GroundingOutcome> = options.skipGrounding
      ? Promise.resolve({
          values: {},
          unavailable: [],
          requiredUnavailable: false,
        })
      : this.startGrounding(
          input,
          sources.data.sources,
          referencedGroundingKeys(rules.data),
        );

    try {
      const budget = new TurnBudget(timeoutMs);
      const prepared = await budget.race(
        ImageOptimizer.optimizeForExtraction(input.image),
      );
      const response = await budget.race(
        this.orchestrator.analyzeImageForSpecialist(binding.specialist.id, {
          prompt: EXTRACTION_USER_PROMPT,
          systemPrompt: buildSystemPrompt(
            schema,
            binding.specialist.promptTemplate,
          ),
          imageBuffer: prepared,
          mimeType: 'image/jpeg',
          maxTokens: MAX_OUTPUT_TOKENS,
          effort: 'low',
        }),
      );

      const parsed = parseExtraction(response.content, schema);
      if (!parsed.ok) {
        return {
          ...failure(parsed.reason, schema),
          modelUsed: response.modelUsed,
          tokens: response.tokensUsed,
          ...usageOf(response),
        };
      }

      const grounded = await grounding;
      const decision = decideVerdict(
        {
          variables: parsed.output.variables,
          legibility: parsed.output.legibility,
          isExpectedDocument: parsed.output.isExpectedDocument,
        },
        schema,
        rules.data,
        {
          grounding: grounded.values,
          requiredUnavailable: grounded.requiredUnavailable,
          now: new Date(),
          timeZone:
            this.config.get<string>('whatsapp.timeZone') ?? 'America/Bogota',
        },
      );
      return {
        verdict: decision.verdict,
        reasonCodes: decision.reasonCodes,
        fields: parsed.output.variables,
        schema,
        confidence: parsed.output.confidence ?? 0,
        modelUsed: response.modelUsed,
        tokens: response.tokensUsed,
        ...usageOf(response),
      };
    } catch (error) {
      const code = this.classify(error);
      this.logger.warn(
        `Especialista ${binding.specialist.id}: ${code} | ${this.describe(error)}`,
      );
      return failure(code, schema);
    }
  }

  private startGrounding(
    input: SpecialistRunInput,
    sources: Parameters<GroundingResolver['resolve']>[0]['sources'],
    neededKeys: ReadonlySet<string>,
  ): Promise<GroundingOutcome> {
    const hadRequired = sources.some((source) => source.required);
    return this.grounding
      .resolve({
        tenantId: input.tenantId,
        botConfigId: input.botConfigId,
        conversationId: input.conversationId,
        contactAddress: input.contactAddress,
        sources,
        neededKeys,
      })
      .catch((error: unknown) => {
        this.logger.warn(
          `No se pudo resolver el contexto: ${this.describe(error)}`,
        );
        return {
          values: {},
          unavailable: [],
          requiredUnavailable: hadRequired,
        };
      });
  }

  private buildResult(analysis: Analysis): VerificationResult {
    const candidate = {
      version: VERDICT_VERSION,
      verdict: analysis.verdict,
      confidence: analysis.verdict === 'ERROR' ? 0 : analysis.confidence,
      fields: analysis.fields,
      reasonCodes: analysis.reasonCodes,
      humanSummary: summarize(analysis.reasonCodes, analysis.schema),
    };
    const checked = verificationResultSchema.safeParse(candidate);
    if (checked.success) return checked.data;
    return {
      version: VERDICT_VERSION,
      verdict: 'ERROR',
      confidence: 0,
      fields: {},
      reasonCodes: ['INTERNAL_ERROR'],
      humanSummary: summarize(['INTERNAL_ERROR']),
    };
  }

  private async persist(
    input: SpecialistRunInput,
    binding: ResolvedBinding,
    data: {
      hash: ImageHash;
      fingerprint: string | null;
      result: VerificationResult;
      mode: 'SHADOW' | 'ACTIVE';
      latencyMs: number;
      modelUsed: string | null;
      tokens: number;
      inputTokens?: number;
      outputTokens?: number;
    },
  ): Promise<string | null> {
    try {
      const retentionDays = this.config.get<number>(
        'specialists.retentionDays',
      );
      const days = Number.isFinite(retentionDays)
        ? (retentionDays as number)
        : 90;
      const record = await this.prisma.verificationRecord.create({
        data: {
          tenantId: input.tenantId,
          conversationId: input.conversationId,
          botConfigId: input.botConfigId,
          specialistId: binding.specialist.id,
          specialistVersion: binding.specialist.version,
          capability: input.capability,
          subjectHash: data.hash.hash,
          hashVersion: data.hash.version,
          fingerprint: data.fingerprint,
          verdict: data.result.verdict,
          confidence: data.result.confidence,
          fields: data.result.fields,
          reasonCodes: data.result.reasonCodes,
          modelUsed: data.modelUsed,
          tokens: data.tokens,
          inputTokens: data.inputTokens ?? null,
          outputTokens: data.outputTokens ?? null,
          latencyMs: data.latencyMs,
          mode: data.mode,
          comparison: this.compare(
            await this.settleLegacy(input.legacy),
            data.result.verdict,
          ),
          expiresAt: new Date(Date.now() + days * DAY_MS),
        },
        select: { id: true },
      });
      return record.id;
    } catch (error) {
      this.logger.error(
        `No se pudo guardar el resultado del especialista: ${this.describe(error)}`,
      );
      return null;
    }
  }

  private async settleLegacy(
    legacy: SpecialistRunInput['legacy'],
  ): Promise<LegacyImageVerdict | undefined> {
    try {
      return await legacy;
    } catch {
      return undefined;
    }
  }

  private compare(
    legacy: LegacyImageVerdict | undefined,
    verdict: Verdict,
  ): Prisma.InputJsonValue | typeof Prisma.JsonNull {
    if (!legacy) return Prisma.JsonNull;
    return {
      legacyValid: legacy.valid,
      legacyConfidence: legacy.confidence,
      agrees: legacy.valid === (verdict === 'VALID'),
    };
  }

  private classify(error: unknown): string {
    if (error instanceof BudgetExceededError) return 'TIMEOUT';
    const message = error instanceof Error ? error.message : '';
    if (/Sin modelos disponibles/i.test(message)) return 'NO_MODEL';
    return 'PROVIDER_ERROR';
  }

  private describe(error: unknown): string {
    return maskSecrets(error instanceof Error ? error.message : String(error));
  }
}

interface Analysis {
  verdict: Verdict;
  reasonCodes: string[];
  fields: Variables;
  schema: OutputSchemaDocument;
  confidence: number;
  modelUsed: string | null;
  tokens: number;
  inputTokens?: number;
  outputTokens?: number;
}

function usageOf(response: {
  usage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
}): { inputTokens?: number; outputTokens?: number } {
  const usage = response.usage;
  if (!usage) return {};
  return {
    inputTokens: usage.input + usage.cacheRead + usage.cacheWrite,
    outputTokens: usage.output,
  };
}

function failure(
  code: string,
  schema: OutputSchemaDocument = EMPTY_OUTPUT_SCHEMA,
): Analysis {
  return {
    verdict: 'ERROR',
    reasonCodes: [code],
    fields: {},
    schema,
    confidence: 0,
    modelUsed: null,
    tokens: 0,
  };
}
