import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import sharp from 'sharp';
import { PrismaService } from 'src/shared/prisma.service';
import {
  contextSourcesDocumentSchema,
  outputSchemaDocumentSchema,
  rulesDocumentSchema,
  validateRulesAgainst,
} from '../contracts';
import { undeclaredGroundingKeys } from '../grounding-config';
import { SpecialistRuntime } from '../SpecialistRuntime';
import { ModelPrice, buildPriceTable, estimateCostUsd } from '../pricing';
import { parseOrThrow } from './specialist-admin.schemas';
import {
  DEFAULT_PAGE_SIZE,
  decodeCursor,
  dryRunDraftSchema,
  encodeCursor,
  listVerificationsSchema,
  REVIEWABLE_VERDICTS,
  reviewVerificationSchema,
} from './specialist-verification.schemas';

export const DRY_RUN_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const DRY_RUN_FORMATS = new Set(['jpeg', 'png', 'webp']);
const RATE_WINDOW_MS = 60_000;

const VERIFICATION_SELECT = {
  id: true,
  conversationId: true,
  botConfigId: true,
  specialistId: true,
  specialistVersion: true,
  capability: true,
  subjectHash: true,
  verdict: true,
  confidence: true,
  fields: true,
  reasonCodes: true,
  modelUsed: true,
  tokens: true,
  inputTokens: true,
  outputTokens: true,
  latencyMs: true,
  mode: true,
  comparison: true,
  consumedAt: true,
  reviewedAt: true,
  reviewedBy: true,
  reviewDecision: true,
  reviewNote: true,
  createdAt: true,
  expiresAt: true,
} satisfies Prisma.VerificationRecordSelect;

const SPECIALIST_SELECT = {
  id: true,
  capability: true,
  version: true,
  promptTemplate: true,
  outputSchema: true,
  rules: true,
  contextSources: true,
} satisfies Prisma.SpecialistSelect;

@Injectable()
export class SpecialistVerificationService {
  private readonly prices: Record<string, ModelPrice>;
  private readonly windows = new Map<
    string,
    { startedAt: number; count: number }
  >();

  constructor(
    private readonly prisma: PrismaService,
    private readonly runtime: SpecialistRuntime,
    private readonly config: ConfigService,
  ) {
    this.prices = buildPriceTable(
      this.config.get<string>('specialists.priceTable'),
    );
  }

  async list(tenantId: string, query: unknown) {
    const filters = parseOrThrow(listVerificationsSchema, query);
    const limit = filters.limit ?? DEFAULT_PAGE_SIZE;

    const and: Prisma.VerificationRecordWhereInput[] = [];
    if (filters.cursor) {
      const cursor = decodeCursor(filters.cursor);
      if (!cursor) {
        throw new BadRequestException({
          message: 'Cursor inválido',
          details: { issues: [{ path: 'cursor', message: 'Cursor inválido' }] },
        });
      }
      and.push({
        OR: [
          { createdAt: { lt: cursor.createdAt } },
          { createdAt: cursor.createdAt, id: { lt: cursor.id } },
        ],
      });
    }

    const where: Prisma.VerificationRecordWhereInput = {
      tenantId,
      ...(filters.specialistId && { specialistId: filters.specialistId }),
      ...(filters.botConfigId && { botConfigId: filters.botConfigId }),
      ...(filters.conversationId && {
        conversationId: filters.conversationId,
      }),
      ...(filters.capability && { capability: filters.capability }),
      ...(filters.verdict && { verdict: filters.verdict }),
      ...(filters.mode && { mode: filters.mode }),
      ...(filters.reasonCode && {
        reasonCodes: { has: filters.reasonCode },
      }),
      ...(filters.pendingReview === true && {
        verdict: { in: ['NEEDS_REVIEW', 'ERROR'] },
        reviewedAt: null,
      }),
      ...((filters.from || filters.to) && {
        createdAt: {
          ...(filters.from && { gte: new Date(filters.from) }),
          ...(filters.to && { lte: new Date(filters.to) }),
        },
      }),
      ...(and.length > 0 && { AND: and }),
    };

    const rows = await this.prisma.verificationRecord.findMany({
      where,
      select: VERIFICATION_SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];

    return {
      items: page.map((row) => this.present(row)),
      nextCursor:
        rows.length > limit && last
          ? encodeCursor(last.createdAt, last.id)
          : null,
    };
  }

  async get(tenantId: string, id: string) {
    const row = await this.prisma.verificationRecord.findFirst({
      where: { id, tenantId },
      select: VERIFICATION_SELECT,
    });
    if (!row) throw new NotFoundException('Verificación no encontrada');
    return this.present(row);
  }

  async review(tenantId: string, actor: string, id: string, body: unknown) {
    const input = parseOrThrow(reviewVerificationSchema, body);
    const found = await this.prisma.verificationRecord.findFirst({
      where: { id, tenantId },
      select: { verdict: true, reviewedAt: true },
    });
    if (!found) throw new NotFoundException('Verificación no encontrada');
    if (!(REVIEWABLE_VERDICTS as readonly string[]).includes(found.verdict)) {
      throw new ConflictException({
        message: 'Solo se revisan resultados dudosos o con error',
        details: { code: 'NOT_REVIEWABLE', verdict: found.verdict },
      });
    }

    const updated = await this.prisma.verificationRecord.updateMany({
      where: {
        id,
        tenantId,
        reviewedAt: null,
        verdict: { in: [...REVIEWABLE_VERDICTS] },
      },
      data: {
        reviewedAt: new Date(),
        reviewedBy: actor,
        reviewDecision: input.decision,
        reviewNote: input.note ?? null,
      },
    });
    if (updated.count === 0) {
      throw new ConflictException({
        message: 'Esta verificación ya fue revisada',
        details: { code: 'ALREADY_REVIEWED' },
      });
    }
    return this.get(tenantId, id);
  }

  async dryRun(
    tenantId: string,
    specialistId: string,
    image: { buffer: Buffer } | undefined,
    rawDraft: unknown,
  ) {
    this.consumeQuota(tenantId);

    if (!image?.buffer?.length) {
      throw this.invalid('file', 'Adjunta una imagen en el campo "file"');
    }
    if (image.buffer.length > DRY_RUN_MAX_IMAGE_BYTES) {
      throw this.invalid('file', 'La imagen supera el tamaño máximo (5 MB)');
    }
    await this.assertSupportedImage(image.buffer);

    const draft = parseOrThrow(dryRunDraftSchema, this.parseDraft(rawDraft));

    const specialist = await this.prisma.specialist.findFirst({
      where: { id: specialistId, tenantId, archivedAt: null },
      select: SPECIALIST_SELECT,
    });
    if (!specialist) throw new NotFoundException('Especialista no encontrado');

    const outputSchema = draft.outputSchema ?? specialist.outputSchema;
    const rules = draft.rules ?? specialist.rules;
    const contextSources = draft.contextSources ?? specialist.contextSources;
    this.assertCoherent(outputSchema, rules, contextSources);

    const outcome = await this.runtime.dryRun({
      tenantId,
      specialistId: specialist.id,
      version: specialist.version,
      capability: specialist.capability,
      promptTemplate: draft.promptTemplate ?? specialist.promptTemplate,
      outputSchema,
      rules,
      contextSources,
      image: image.buffer,
    });

    return {
      dryRun: true,
      persisted: false,
      usedDraft: {
        promptTemplate: draft.promptTemplate !== undefined,
        outputSchema: draft.outputSchema !== undefined,
        rules: draft.rules !== undefined,
        contextSources: draft.contextSources !== undefined,
      },
      groundingSkipped: true,
      verdict: outcome.result.verdict,
      confidence: outcome.result.confidence,
      fields: outcome.result.fields,
      reasonCodes: outcome.result.reasonCodes,
      humanSummary: outcome.result.humanSummary,
      modelUsed: outcome.modelUsed,
      tokens: {
        total: outcome.tokens,
        input: outcome.inputTokens,
        output: outcome.outputTokens,
      },
      latencyMs: outcome.latencyMs,
      estimatedCostUsd: estimateCostUsd(
        this.prices,
        outcome.modelUsed,
        outcome.inputTokens,
        outcome.outputTokens,
      ),
    };
  }

  private present(
    row: Prisma.VerificationRecordGetPayload<{
      select: typeof VERIFICATION_SELECT;
    }>,
  ) {
    const { inputTokens, outputTokens, tokens, ...rest } = row;
    return {
      ...rest,
      tokens: { total: tokens, input: inputTokens, output: outputTokens },
      estimatedCostUsd: estimateCostUsd(
        this.prices,
        row.modelUsed,
        inputTokens,
        outputTokens,
      ),
    };
  }

  private consumeQuota(tenantId: string): void {
    const limit = this.config.get<number>('specialists.dryRunPerMinute') ?? 10;
    const now = Date.now();
    const current = this.windows.get(tenantId);
    if (!current || now - current.startedAt >= RATE_WINDOW_MS) {
      this.windows.set(tenantId, { startedAt: now, count: 1 });
      this.pruneWindows(now);
      return;
    }
    if (current.count >= limit) {
      const retryAfterSeconds = Math.ceil(
        (RATE_WINDOW_MS - (now - current.startedAt)) / 1000,
      );
      throw new HttpException(
        {
          message: 'Demasiadas pruebas en poco tiempo',
          details: { retryAfterSeconds, limitPerMinute: limit },
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    current.count += 1;
  }

  private pruneWindows(now: number): void {
    if (this.windows.size < 500) return;
    for (const [tenant, window] of this.windows) {
      if (now - window.startedAt >= RATE_WINDOW_MS) this.windows.delete(tenant);
    }
  }

  private parseDraft(raw: unknown): unknown {
    if (raw === undefined || raw === null || raw === '') return {};
    if (typeof raw !== 'string') return raw;
    try {
      return JSON.parse(raw);
    } catch {
      throw this.invalid('draft', 'El borrador no es un JSON válido');
    }
  }

  private async assertSupportedImage(buffer: Buffer): Promise<void> {
    let format: string | undefined;
    try {
      format = (await sharp(buffer).metadata()).format;
    } catch {
      format = undefined;
    }
    if (!format || !DRY_RUN_FORMATS.has(format)) {
      throw this.invalid(
        'file',
        'Formato de imagen no soportado (JPEG, PNG o WebP)',
      );
    }
  }

  private assertCoherent(
    outputSchema: unknown,
    rules: unknown,
    contextSources: unknown,
  ): void {
    const parsedSchema = outputSchemaDocumentSchema.safeParse(outputSchema);
    const parsedRules = rulesDocumentSchema.safeParse(rules);
    const parsedSources =
      contextSourcesDocumentSchema.safeParse(contextSources);
    if (
      !parsedSchema.success ||
      !parsedRules.success ||
      !parsedSources.success
    ) {
      throw this.invalid(
        'draft',
        'Las variables, reglas o fuentes de contexto no son válidas',
      );
    }
    const ruleIssues = validateRulesAgainst(
      parsedSchema.data,
      parsedRules.data,
    );
    if (ruleIssues.length > 0) {
      throw this.invalid(
        'draft.rules',
        ruleIssues.map((issue) => issue.message).join('; '),
      );
    }
    const undeclared = undeclaredGroundingKeys(
      parsedRules.data,
      parsedSources.data.sources,
    );
    if (undeclared.length > 0) {
      throw this.invalid(
        'draft.rules',
        `Las reglas usan claves de contexto sin declarar: ${undeclared.join(', ')}`,
      );
    }
  }

  private invalid(path: string, message: string): BadRequestException {
    return new BadRequestException({
      message: 'Datos inválidos',
      details: { issues: [{ path, message }] },
    });
  }
}
