import { Injectable } from '@nestjs/common';
import { PromptTemplateType } from '@prisma/client';
import { TemplateRepository } from './repositories/TemplateRepository';
import {
  SETTINGS_DEFAULTS,
  SettingsRepository,
} from './repositories/SettingsRepository';
import { PromptEngine } from './PromptEngine';

@Injectable()
export class PromptService {
  constructor(
    private readonly templates: TemplateRepository,
    private readonly settings: SettingsRepository,
    private readonly engine: PromptEngine,
  ) {}

  listAll(botConfigId: string) {
    return this.templates.findAll(botConfigId);
  }

  async getOne(botConfigId: string, type: PromptTemplateType) {
    const content = await this.templates.findActive(botConfigId, type);
    const defaultContent = this.templates.getDefault(type);
    return {
      type,
      content,
      isCustom: content !== defaultContent,
      default: defaultContent,
    };
  }

  update(botConfigId: string, type: PromptTemplateType, content: string) {
    return this.templates.upsert(botConfigId, type, content);
  }

  async preview(botConfigId: string, type: PromptTemplateType) {
    const rendered = await this.engine.preview(botConfigId, type);
    return { type, rendered, tokenEstimate: Math.ceil(rendered.length / 4) };
  }

  async getSettings(botConfigId: string) {
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

  updateSettings(botConfigId: string, data: any) {
    return this.settings.upsert(botConfigId, data);
  }
}
