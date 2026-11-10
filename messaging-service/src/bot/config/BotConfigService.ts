import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from 'src/shared/prisma.service';
import { CreateBotConfigDto } from '../dto/create-bot-config.dto';
import {
  AiModelRole,
  AiProvider,
  BotStatus,
  Prisma,
  PromptTemplateType,
} from '@prisma/client';
import { CreateAiModelDto } from '../dto/create-ai-model.dto';
import { SecretEncryptionService } from 'src/shared/security/secret-encryption.service';
import { AI_MODEL_PUBLIC_SELECT } from '../dto/ai-model-public';
import { resolveUniqueKey, slugifyKey } from 'src/shared/stable-key';
import { findUnknownToolReferences } from '../prompt/tool-references';

@Injectable()
export class BotConfigService {
  private readonly logger = new Logger(BotConfigService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly encryption: SecretEncryptionService,
  ) {}

  async create(tenantId: string, dto: CreateBotConfigDto) {
    const key = await this.resolveKey(tenantId, dto.key, dto.name);
    return this.prisma.botConfig.create({
      data: {
        tenantId,
        key,
        name: dto.name,
        systemPrompt: dto.systemPrompt,
        imageAnalysisEnabled: dto.imageAnalysisEnabled ?? false,
        clientApiBaseUrl: dto.clientApiBaseUrl ?? '',
        clientApiHeaders: dto.clientApiHeaders ?? {},
        intentEndpoints: (dto.intentEndpoints ?? {}) as Prisma.JsonObject,
        maxHistoryMessages: dto.maxHistoryMessages ?? 10,
        maxMessageAgeMinutes: dto.maxMessageAgeMinutes ?? 1440,
        humanTakeoverMinutes: dto.humanTakeoverMinutes ?? 10,
        botResponseDelaySeconds: dto.botResponseDelaySeconds ?? 8,
        conversationTimeoutMinutes: dto.conversationTimeoutMinutes ?? 60,
        status: BotStatus.INACTIVE,
      },

      select: this.safeSelect(),
    });
  }

  async findByKey(key: string, tenantId: string) {
    const config = await this.prisma.botConfig.findFirst({
      where: { tenantId, key },
      select: this.safeSelect(),
    });
    if (!config) {
      throw new NotFoundException(`Bot con clave "${key}" no encontrado`);
    }
    return config;
  }

  private async resolveKey(
    tenantId: string,
    requested: string | undefined,
    name: string,
    excludeId?: string,
  ): Promise<string> {
    const taken = async (candidate: string) =>
      (await this.prisma.botConfig.count({
        where: {
          tenantId,
          key: candidate,
          ...(excludeId ? { id: { not: excludeId } } : {}),
        },
      })) > 0;

    if (requested) {
      if (await taken(requested)) {
        throw new ConflictException(
          `Ya existe un bot con la clave "${requested}" en este tenant.`,
        );
      }
      return requested;
    }
    return resolveUniqueKey(slugifyKey(name, 'bot'), taken);
  }

  async findAll(tenantId: string) {
    return this.prisma.botConfig.findMany({
      where: { tenantId },
      select: {
        ...this.safeSelect(),
        aiModels: {
          where: { isActive: true },
          select: AI_MODEL_PUBLIC_SELECT,
          orderBy: [{ role: 'asc' }, { priority: 'asc' }],
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string, tenantId: string) {
    const config = await this.prisma.botConfig.findUnique({
      where: { id, tenantId },
      select: {
        ...this.safeSelect(),
        aiModels: {
          where: { isActive: true },
          select: AI_MODEL_PUBLIC_SELECT,
          orderBy: [{ role: 'asc' }, { priority: 'asc' }],
        },
      },
    });
    if (!config) throw new NotFoundException(`BotConfig ${id} no encontrado`);
    return config;
  }

  async findOneWithSecret(id: string) {
    const config = await this.prisma.botConfig.findUnique({ where: { id } });
    if (!config) throw new NotFoundException(`BotConfig ${id} no encontrado`);
    return config;
  }

  async findOneForBot(id: string) {
    const config = await this.prisma.botConfig.findUnique({
      where: { id },
      include: {
        aiModels: {
          where: { isActive: true },
          select: AI_MODEL_PUBLIC_SELECT,
          orderBy: [{ role: 'asc' }, { priority: 'asc' }],
        },
      },
    });
    if (!config) throw new NotFoundException(`BotConfig ${id} no encontrado`);
    return config;
  }

  async update(id: string, dto: Partial<CreateBotConfigDto>, tenantId: string) {
    await this.findOne(id, tenantId);
    const data: Prisma.BotConfigUpdateInput = {};

    if (dto.name !== undefined) data.name = dto.name;
    if (dto.key !== undefined)
      data.key = await this.resolveKey(tenantId, dto.key, dto.name ?? '', id);
    if (dto.systemPrompt !== undefined) data.systemPrompt = dto.systemPrompt;
    if (dto.imageAnalysisEnabled !== undefined)
      data.imageAnalysisEnabled = dto.imageAnalysisEnabled;
    if (dto.clientApiBaseUrl !== undefined)
      data.clientApiBaseUrl = dto.clientApiBaseUrl;
    if (dto.clientApiHeaders !== undefined)
      data.clientApiHeaders = dto.clientApiHeaders as Prisma.JsonObject;
    if (dto.intentEndpoints !== undefined)
      data.intentEndpoints = dto.intentEndpoints as Prisma.JsonObject;
    if (dto.maxHistoryMessages !== undefined)
      data.maxHistoryMessages = dto.maxHistoryMessages;
    if (dto.conversationTimeoutMinutes !== undefined)
      data.conversationTimeoutMinutes = dto.conversationTimeoutMinutes;
    if (dto.maxMessageAgeMinutes !== undefined)
      data.maxMessageAgeMinutes = dto.maxMessageAgeMinutes;
    if (dto.humanTakeoverMinutes !== undefined)
      data.humanTakeoverMinutes = dto.humanTakeoverMinutes;
    if (dto.botResponseDelaySeconds !== undefined)
      data.botResponseDelaySeconds = dto.botResponseDelaySeconds;

    return this.prisma.botConfig.update({
      where: { id },
      data,
      select: this.safeSelect(),
    });
  }

  async toggle(
    id: string,
    tenantId: string,
  ): Promise<{ id: string; status: BotStatus }> {
    await this.findOne(id, tenantId);

    const config = await this.prisma.botConfig.findUnique({ where: { id } });
    if (!config) throw new NotFoundException(`BotConfig ${id} no encontrado`);

    const newStatus =
      config!.status === BotStatus.ACTIVE
        ? BotStatus.INACTIVE
        : BotStatus.ACTIVE;

    if (newStatus === BotStatus.ACTIVE) await this.assertCanActivate(id);

    const updated = await this.prisma.botConfig.update({
      where: { id },
      data: { status: newStatus },
      select: { id: true, status: true, name: true },
    });

    this.logger.log(`Bot ${updated.name} → ${newStatus}`);
    return updated;
  }

  async getConfigById(botConfigId: string) {
    return this.prisma.botConfig.findFirst({
      where: { id: botConfigId, status: BotStatus.ACTIVE },
      include: {
        aiModels: {
          where: { isActive: true },
          select: AI_MODEL_PUBLIC_SELECT,
          orderBy: [{ role: 'asc' }, { priority: 'asc' }],
        },
      },
    });
  }

  async getConfigForRouting(botConfigId: string, tenantId: string) {
    return this.prisma.botConfig.findFirst({
      where: { id: botConfigId, tenantId },
      include: {
        aiModels: {
          where: { isActive: true },
          select: AI_MODEL_PUBLIC_SELECT,
          orderBy: [{ role: 'asc' }, { priority: 'asc' }],
        },
      },
    });
  }

  async findActiveForTenant(tenantId: string) {
    return this.prisma.botConfig.findFirst({
      where: { tenantId, status: BotStatus.ACTIVE },
      select: { id: true, name: true },
    });
  }

  async addAiModel(
    botConfigId: string,
    dto: CreateAiModelDto,
    tenantId: string,
  ) {
    await this.findOne(botConfigId, tenantId);

    return this.prisma.aiModelConfig.create({
      data: {
        botConfigId,
        provider: dto.provider,
        model: dto.model,
        apiKey: this.encryption.seal(dto.apiKey.trim()),
        apiKeyLast4: this.encryption.last4(dto.apiKey),
        baseUrl: dto.baseUrl,
        role: dto.role,
        tier: dto.tier,
        priority: dto.priority,
        dailyTokenLimit: dto.dailyTokenLimit,
        minuteRequestLimit: dto.minuteRequestLimit,
      },
      select: AI_MODEL_PUBLIC_SELECT,
    });
  }

  async getAiModels(botConfigId: string, tenantId: string) {
    await this.findOne(botConfigId, tenantId);

    return this.prisma.aiModelConfig.findMany({
      where: { botConfigId },
      orderBy: [{ role: 'asc' }, { priority: 'asc' }],
      select: AI_MODEL_PUBLIC_SELECT,
    });
  }

  async removeAiModel(botConfigId: string, modelId: string, tenantId: string) {
    await this.findOne(botConfigId, tenantId);

    const model = await this.prisma.aiModelConfig.findFirst({
      where: { id: modelId, botConfigId },
      select: { id: true },
    });
    if (!model) throw new NotFoundException(`Modelo ${modelId} no encontrado`);

    return this.prisma.aiModelConfig.delete({
      where: { id: modelId },
      select: AI_MODEL_PUBLIC_SELECT,
    });
  }

  async resetModelCounters(
    botConfigId: string,
    modelId: string,
    tenantId: string,
  ) {
    await this.findOne(botConfigId, tenantId);

    const model = await this.prisma.aiModelConfig.findFirst({
      where: { id: modelId, botConfigId },
      select: { id: true },
    });
    if (!model) throw new NotFoundException(`Modelo ${modelId} no encontrado`);

    return this.prisma.aiModelConfig.update({
      where: { id: modelId },
      data: {
        tokensUsedToday: 0,
        requestsThisMinute: 0,
        lastResetAt: new Date(),
        lastMinuteResetAt: new Date(),
        credentialInvalidAt: null,
        consecutiveFailures: 0,
        unavailableUntil: null,
        lastErrorType: null,
        lastErrorAt: null,
      },
      select: AI_MODEL_PUBLIC_SELECT,
    });
  }

  private async assertCanActivate(botConfigId: string): Promise<void> {
    const template = await this.prisma.botPromptTemplate.findFirst({
      where: {
        botConfigId,
        type: PromptTemplateType.CONVERSATION,
        isActive: true,
      },
      select: { content: true },
    });
    if (!template?.content.trim()) {
      throw new BadRequestException(
        'El bot no tiene una plantilla CONVERSATION propia; sin ella respondería con la plantilla genérica. Guárdala en prompts/CONVERSATION antes de activarlo.',
      );
    }
    const tools = await this.prisma.toolDefinition.findMany({
      where: { botConfigId, isActive: true },
      select: { name: true },
    });
    const unknown = findUnknownToolReferences(
      template.content,
      tools.map((t) => t.name),
    );
    if (unknown.length > 0) {
      throw new BadRequestException(
        `La plantilla CONVERSATION nombra herramientas que el bot no tiene: ${unknown.join(', ')}.`,
      );
    }
    const usable = await this.prisma.aiModelConfig.count({
      where: {
        botConfigId,
        isActive: true,
        credentialInvalidAt: null,
        role: { in: [AiModelRole.CONVERSATION, AiModelRole.FALLBACK] },
      },
    });
    if (usable < 2) {
      this.logger.warn(
        `El bot ${botConfigId} se activa con ${usable} modelo(s) de IA utilizable(s): sin respaldo, una caída del proveedor deja a los clientes sin respuesta de la IA.`,
      );
    }
  }

  private safeSelect() {
    return {
      id: true,
      tenantId: true,
      key: true,
      name: true,
      status: true,
      systemPrompt: true,
      imageAnalysisEnabled: true,
      clientApiBaseUrl: true,
      clientApiHeaders: true,
      intentEndpoints: true,
      maxHistoryMessages: true,
      conversationTimeoutMinutes: true,
      maxMessageAgeMinutes: true,
      humanTakeoverMinutes: true,
      botResponseDelaySeconds: true,
      createdAt: true,
      updatedAt: true,
    };
  }
}
