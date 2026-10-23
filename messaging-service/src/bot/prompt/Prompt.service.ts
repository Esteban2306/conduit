import { UpdateAiSettingsDto } from './dto/update-ai-settings.dto';
import { BadRequestException, Injectable } from '@nestjs/common';
import { PromptTemplateType } from '@prisma/client';
import { TemplateRepository } from './repositories/TemplateRepository';
import {
  SETTINGS_DEFAULTS,
  SettingsRepository,
} from './repositories/SettingsRepository';
import { PromptEngine } from './PromptEngine';
import { BotConfigService } from '../config/BotConfigService';
import { PrismaService } from 'src/shared/prisma.service';
import { findUnknownToolReferences } from './tool-references';

@Injectable()
export class PromptService {
  constructor(
    private readonly engine: PromptEngine,
    private readonly templates: TemplateRepository,
    private readonly settings: SettingsRepository,
    private readonly botConfig: BotConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async listAll(botConfigId: string, tenantId: string) {
    await this.botConfig.findOne(botConfigId, tenantId);
    return this.templates.findAll(botConfigId);
  }

  async getOne(
    botConfigId: string,
    type: PromptTemplateType,
    tenantId: string,
  ) {
    await this.botConfig.findOne(botConfigId, tenantId);

    const content = await this.templates.findActive(botConfigId, type);
    const defaultContent = this.templates.getDefault(type);
    return {
      type,
      content,
      isCustom: content !== defaultContent,
      default: defaultContent,
    };
  }

  async update(
    botConfigId: string,
    type: PromptTemplateType,
    content: string,
    tenantId: string,
  ) {
    await this.botConfig.findOne(botConfigId, tenantId);
    if (type === PromptTemplateType.CONVERSATION) {
      await this.assertKnownTools(botConfigId, content);
    }
    return this.templates.upsert(botConfigId, type, content);
  }

  async preview(
    botConfigId: string,
    type: PromptTemplateType,
    tenantId: string,
  ) {
    await this.botConfig.findOne(botConfigId, tenantId);

    const rendered = await this.engine.preview(botConfigId, type);
    return { type, rendered, tokenEstimate: Math.ceil(rendered.length / 4) };
  }

  async getSettings(botConfigId: string, tenantId: string) {
    await this.botConfig.findOne(botConfigId, tenantId);
    const saved = await this.settings.findByBot(botConfigId);

    if (!saved) {
      return {
        configured: false,
        message:
          'Sin configuración guardada. Estos son los valores por defecto.',
        settings: SETTINGS_DEFAULTS,
      };
    }

    return {
      configured: true,
      settings: saved,
    };
  }

  async updateSettings(
    botConfigId: string,
    data: UpdateAiSettingsDto,
    tenantId: string,
  ) {
    await this.botConfig.findOne(botConfigId, tenantId);
    return this.settings.upsert(botConfigId, data);
  }

  private async assertKnownTools(botConfigId: string, content: string) {
    const tools = await this.prisma.toolDefinition.findMany({
      where: { botConfigId, isActive: true },
      select: { name: true },
    });
    const names = tools.map((t) => t.name);
    const unknown = findUnknownToolReferences(content, names);
    if (unknown.length > 0) {
      throw new BadRequestException(
        `La plantilla nombra herramientas que este bot no tiene: ${unknown.join(', ')}. ` +
          `Herramientas activas: ${names.join(', ') || 'ninguna'}.`,
      );
    }
  }
}
