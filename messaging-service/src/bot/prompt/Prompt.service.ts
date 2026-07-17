import { Injectable } from '@nestjs/common';
import { PromptTemplateType } from '@prisma/client';
import { TemplateRepository } from './repositories/TemplateRepository';
import {
  SETTINGS_DEFAULTS,
  SettingsRepository,
} from './repositories/SettingsRepository';
import { PromptEngine } from './PromptEngine';
import { BotConfigService } from '../config/BotConfigService';

@Injectable()
export class PromptService {
  constructor(
    private readonly engine: PromptEngine,
    private readonly templates: TemplateRepository,
    private readonly settings: SettingsRepository,
    private readonly botConfig: BotConfigService,
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

  async updateSettings(botConfigId: string, data: any, tenantId: string) {
    await this.botConfig.findOne(botConfigId, tenantId);
    return this.settings.upsert(botConfigId, data);
  }
}
