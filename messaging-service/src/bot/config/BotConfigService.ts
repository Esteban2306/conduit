import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from 'src/shared/prisma.service';
import { CreateBotConfigDto } from '../dto/create-bot-config.dto';
import { AiProvider, BotStatus, Prisma } from '@prisma/client';
import { CreateAiModelDto } from '../dto/create-ai-model.dto';

@Injectable()
export class BotConfigService {
  private readonly logger = new Logger(BotConfigService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async create(dto: CreateBotConfigDto) {
    const tenantId = this.config.get<string>('tenant.defaultId') ?? 'default';

    return this.prisma.botConfig.create({
      data: {
        tenantId,
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

  async findAll() {
    const tenantId = this.config.get<string>('tenant.defaultId') ?? 'default';
    return this.prisma.botConfig.findMany({
      where: { tenantId },
      select: {
        ...this.safeSelect(),
        aiModels: {
          where: { isActive: true },
          select: {
            id: true,
            provider: true,
            model: true,
            role: true,
            tier: true,
            priority: true,
            tokensUsedToday: true,
            dailyTokenLimit: true,
          },
          orderBy: [{ role: 'asc' }, { priority: 'asc' }],
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string) {
    const config = await this.prisma.botConfig.findUnique({
      where: { id },
      select: {
        ...this.safeSelect(),
        aiModels: {
          where: { isActive: true },
          select: {
            id: true,
            provider: true,
            model: true,
            role: true,
            tier: true,
            priority: true,
            tokensUsedToday: true,
            dailyTokenLimit: true,
            minuteRequestLimit: true,
            requestsThisMinute: true,
          },
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
          orderBy: [{ role: 'asc' }, { priority: 'asc' }],
        },
      },
    });
    if (!config) throw new NotFoundException(`BotConfig ${id} no encontrado`);
    return config;
  }

  async update(id: string, dto: Partial<CreateBotConfigDto>) {
    await this.findOne(id);
    const data: Prisma.BotConfigUpdateInput = {};

    if (dto.name !== undefined) data.name = dto.name;
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

    return this.prisma.botConfig.update({
      where: { id },
      data,
      select: this.safeSelect(),
    });
  }

  async toggle(id: string): Promise<{ id: string; status: BotStatus }> {
    const config = await this.prisma.botConfig.findUnique({ where: { id } });
    if (!config) throw new NotFoundException(`BotConfig ${id} no encontrado`);

    const newStatus =
      config.status === BotStatus.ACTIVE
        ? BotStatus.INACTIVE
        : BotStatus.ACTIVE;

    const updated = await this.prisma.botConfig.update({
      where: { id },
      data: { status: newStatus },
      select: { id: true, status: true, name: true },
    });

    this.logger.log(`Bot ${updated.name} → ${newStatus}`);
    return updated;
  }

  async getActiveConfig() {
    const tenantId = this.config.get<string>('tenant.defaultId') ?? 'default';
    return this.prisma.botConfig.findFirst({
      where: { tenantId, status: BotStatus.ACTIVE },
      include: {
        aiModels: {
          where: { isActive: true },
          orderBy: [{ role: 'asc' }, { priority: 'asc' }],
        },
      },
    });
  }

  async addAiModel(botConfigId: string, dto: CreateAiModelDto) {
    await this.findOne(botConfigId);

    return this.prisma.aiModelConfig.create({
      data: {
        botConfigId,
        provider: dto.provider,
        model: dto.model,
        apiKey: dto.apiKey,
        baseUrl: dto.baseUrl,
        role: dto.role,
        tier: dto.tier,
        priority: dto.priority,
        dailyTokenLimit: dto.dailyTokenLimit,
        minuteRequestLimit: dto.minuteRequestLimit,
      },
      select: {
        id: true,
        provider: true,
        model: true,
        role: true,
        tier: true,
        priority: true,
        dailyTokenLimit: true,
        minuteRequestLimit: true,
        tokensUsedToday: true,
        isActive: true,
        createdAt: true,
      },
    });
  }

  async getAiModels(botConfigId: string) {
    await this.findOne(botConfigId);

    return this.prisma.aiModelConfig.findMany({
      where: { botConfigId },
      orderBy: [{ role: 'asc' }, { priority: 'asc' }],
      select: {
        id: true,
        provider: true,
        model: true,
        role: true,
        tier: true,
        priority: true,
        dailyTokenLimit: true,
        minuteRequestLimit: true,
        tokensUsedToday: true,
        requestsThisMinute: true,
        isActive: true,
        createdAt: true,
      },
    });
  }

  async removeAiModel(botConfigId: string, modelId: string) {
    const model = await this.prisma.aiModelConfig.findFirst({
      where: { id: modelId, botConfigId },
    });
    if (!model) throw new NotFoundException(`Modelo ${modelId} no encontrado`);

    return this.prisma.aiModelConfig.delete({ where: { id: modelId } });
  }

  async resetModelCounters(modelId: string) {
    return this.prisma.aiModelConfig.update({
      where: { id: modelId },
      data: {
        tokensUsedToday: 0,
        requestsThisMinute: 0,
        lastResetAt: new Date(),
        lastMinuteResetAt: new Date(),
      },
    });
  }

  private safeSelect() {
    return {
      id: true,
      tenantId: true,
      name: true,
      status: true,
      systemPrompt: true,
      imageAnalysisEnabled: true,
      clientApiBaseUrl: true,
      clientApiHeaders: true,
      intentEndpoints: true,
      maxHistoryMessages: true,
      conversationTimeoutMinutes: true,
      createdAt: true,
      updatedAt: true,
    };
  }
}
