import { Injectable, Logger } from '@nestjs/common';
import { ConversationContext } from '../conversation/interfaces/ConversationContext';
import { PromptTemplateType } from '@prisma/client';
import { TemplateRepository } from './repositories/TemplateRepository';
import { SettingsRepository } from './repositories/SettingsRepository';
import { VariableResolver } from './VariableResolver';
import { ContextBuilder } from './ContextBuilder';
import { PromptRenderer } from './PromptRenderer';
import { HistoryMessage } from '../conversation/interfaces/ConversationHistory';
import { KnowledgeAssembler } from '../knowledge/KnowledgeAssembler';

export interface BuiltPrompt {
  systemPrompt: string;
  maxTokens: number;
  temperature: number;
}

export interface PromptBuildInput {
  userMessage: string;
  history: HistoryMessage[];
  context: ConversationContext;
  summary: string | null;
  hasImage?: boolean;
}

@Injectable()
export class PromptEngine {
  private readonly logger = new Logger(PromptEngine.name);

  constructor(
    private readonly templates: TemplateRepository,
    private readonly settingsRepo: SettingsRepository,
    private readonly variables: VariableResolver,
    private readonly contextBuilder: ContextBuilder,
    private readonly renderer: PromptRenderer,
    private readonly knowledge: KnowledgeAssembler,
  ) {}
  async buildConversationPrompt(
    botConfigId: string,
    input: PromptBuildInput,
  ): Promise<BuiltPrompt> {
    const [settings, template, assembled] = await Promise.all([
      this.settingsRepo.findByBot(botConfigId),
      this.templates.findActive(botConfigId, PromptTemplateType.CONVERSATION),
      this.knowledge.assemble(botConfigId),
    ]);

    const vars = this.variables.resolve(settings);
    let systemPrompt = this.renderer.render(template, vars);

    if (assembled.compiled) {
      systemPrompt = `${systemPrompt}\n\nConocimiento:\n${assembled.compiled}`;
    }

    const { block } = this.contextBuilder.build(input.context, input.summary);
    if (block) systemPrompt = `${systemPrompt}\n\n${block}`;

    if (input.history.length > 1) {
      const narrative = this.contextBuilder.buildHistoryNarrative(
        input.history,
      );
      if (narrative) systemPrompt = `${systemPrompt}\n\n${narrative}`;
    }

    this.logger.debug(
      `Prompt built | ~${Math.ceil(systemPrompt.length / 4)} tokens`,
    );

    return {
      systemPrompt,
      maxTokens: settings?.maxTokensConversation ?? 400,
      temperature: settings?.temperature ?? 0.7,
    };
  }

  async buildImagePrompt(botConfigId: string): Promise<BuiltPrompt> {
    const [settings, template] = await Promise.all([
      this.settingsRepo.findByBot(botConfigId),
      this.templates.findActive(botConfigId, PromptTemplateType.IMAGE_ANALYSIS),
    ]);

    const vars = this.variables.resolve(settings);

    return {
      systemPrompt: this.renderer.render(template, vars),
      maxTokens: settings?.maxTokensImage ?? 250,
      temperature: 0.1,
    };
  }

  async buildSummaryPrompt(botConfigId: string): Promise<BuiltPrompt> {
    const [settings, template] = await Promise.all([
      this.settingsRepo.findByBot(botConfigId),
      this.templates.findActive(botConfigId, PromptTemplateType.SUMMARY),
    ]);

    const vars = this.variables.resolve(settings);

    return {
      systemPrompt: this.renderer.render(template, vars),
      maxTokens: settings?.maxTokensSummary ?? 300,
      temperature: 0.3,
    };
  }

  async preview(
    botConfigId: string,
    type: PromptTemplateType,
  ): Promise<string> {
    const [settings, template] = await Promise.all([
      this.settingsRepo.findByBot(botConfigId),
      this.templates.findActive(botConfigId, type),
    ]);

    const vars = this.variables.resolve(settings);
    return this.renderer.render(template, vars);
  }
}
