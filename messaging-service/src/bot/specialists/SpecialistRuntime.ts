import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/shared/prisma.service';
import { AiOrchestrator } from '../ai/AiOrchestrator';
import { BudgetExceededError, TurnBudget } from '../ai/turn-budget';
import { ImageOptimizer } from '../helper/ImageOptimizer';
import { EventBusService } from 'src/infra/events/event.service';
import { EVENT_TYPES } from 'src/infra/events/constants/event.types';
import { maskSecrets } from 'src/shared/security/mask-secrets';
import {
  ExtractedFields,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  VERDICT_VERSION,
  Verdict,
  VerificationResult,
  rulesDocumentSchema,
  verificationResultSchema,
} from './contracts';
import {
  EXTRACTION_USER_PROMPT,
  buildSystemPrompt,
  parseExtraction,
} from './extraction-prompt';
import { decideVerdict, summarize } from './verdict-policy';

const MAX_OUTPUT_TOKENS = 1024;
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
    };

interface ResolvedBinding {
  mode: 'OFF' | 'SHADOW' | 'ACTIVE';
  timeoutMs: number;
  specialist: {
    id: string;
    status: 'ACTIVE' | 'INACTIVE';
    promptTemplate: string;
    rules: unknown;
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
    const subjectHash = createHash('sha256').update(input.image).digest('hex');
    const mode = binding.mode;

    const analysis = await this.analyze(binding, input.image);
    const latencyMs = Date.now() - startedAt;

    const result = this.buildResult(analysis);
    const recordId = await this.persist(input, binding, {
      subjectHash,
      result,
      mode,
      latencyMs,
      modelUsed: analysis.modelUsed,
      tokens: analysis.tokens,
    });

    this.eventBus.publish(EVENT_TYPES.SPECIALIST_COMPLETED, {
      tenantId: input.tenantId,
      botConfigId: input.botConfigId,
      specialistId: binding.specialist.id,
      capability: input.capability,
      verdict: result.verdict,
      mode,
      latencyMs,
      tokens: analysis.tokens,
    });

    return {
      executed: true,
      mode,
      specialistId: binding.specialist.id,
      result,
      recordId,
    };
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
        specialist: {
          select: {
            id: true,
            status: true,
            promptTemplate: true,
            rules: true,
          },
        },
      },
    });
    return row;
  }

  private async analyze(
    binding: ResolvedBinding,
    image: Buffer,
  ): Promise<Analysis> {
    const rules = rulesDocumentSchema.safeParse(binding.specialist.rules);
    if (!rules.success) return failure('RULES_INVALID');

    const timeoutMs = Math.min(
      Math.max(binding.timeoutMs, MIN_TIMEOUT_MS),
      MAX_TIMEOUT_MS,
    );

    try {
      const budget = new TurnBudget(timeoutMs);
      const prepared = await budget.race(
        ImageOptimizer.optimizeForExtraction(image),
      );
      const response = await budget.race(
        this.orchestrator.analyzeImageForSpecialist(binding.specialist.id, {
          prompt: EXTRACTION_USER_PROMPT,
          systemPrompt: buildSystemPrompt(binding.specialist.promptTemplate),
          imageBuffer: prepared,
          mimeType: 'image/jpeg',
          maxTokens: MAX_OUTPUT_TOKENS,
        }),
      );

      const parsed = parseExtraction(response.content);
      if (!parsed.ok) {
        return {
          ...failure(parsed.reason),
          modelUsed: response.modelUsed,
          tokens: response.tokensUsed,
        };
      }

      const decision = decideVerdict(
        {
          fields: parsed.output.fields,
          isExpectedDocument: parsed.output.isExpectedDocument,
        },
        rules.data,
        {
          grounding: {},
          now: new Date(),
          timeZone:
            this.config.get<string>('whatsapp.timeZone') ?? 'America/Bogota',
        },
      );
      return {
        verdict: decision.verdict,
        reasonCodes: decision.reasonCodes,
        fields: parsed.output.fields,
        confidence: parsed.output.confidence ?? 0,
        modelUsed: response.modelUsed,
        tokens: response.tokensUsed,
      };
    } catch (error) {
      const code = this.classify(error);
      this.logger.warn(
        `Especialista ${binding.specialist.id}: ${code} | ${this.describe(error)}`,
      );
      return failure(code);
    }
  }

  private buildResult(analysis: Analysis): VerificationResult {
    const candidate = {
      version: VERDICT_VERSION,
      verdict: analysis.verdict,
      confidence: analysis.verdict === 'ERROR' ? 0 : analysis.confidence,
      fields: analysis.fields,
      reasonCodes: analysis.reasonCodes,
      humanSummary: summarize(analysis.reasonCodes),
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
      subjectHash: string;
      result: VerificationResult;
      mode: 'SHADOW' | 'ACTIVE';
      latencyMs: number;
      modelUsed: string | null;
      tokens: number;
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
          capability: input.capability,
          subjectHash: data.subjectHash,
          verdict: data.result.verdict,
          confidence: data.result.confidence,
          fields: data.result.fields,
          reasonCodes: data.result.reasonCodes,
          modelUsed: data.modelUsed,
          tokens: data.tokens,
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
  fields: ExtractedFields;
  confidence: number;
  modelUsed: string | null;
  tokens: number;
}

function failure(code: string): Analysis {
  return {
    verdict: 'ERROR',
    reasonCodes: [code],
    fields: {},
    confidence: 0,
    modelUsed: null,
    tokens: 0,
  };
}
