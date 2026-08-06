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
import { ExternalDataResolver } from 'src/external/ExternalDataResolver';

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
  hasTools?: boolean;
}

const TOOL_RESULT_DISCIPLINE = `
Cuando uses una herramienta, tu respuesta debe basarse ÚNICAMENTE en el resultado real que esa herramienta devolvió — nunca en lo que asumas o esperes que haya pasado.
Si el resultado de una herramienta incluye "error": true, NUNCA confirmes que la acción se completó exitosamente (no digas que una cita quedó agendada, un pago se procesó, o cualquier acción similar si no fue así). En ese caso, dile al cliente con honestidad que hubo un inconveniente y que una persona del equipo lo contactará pronto.
No inventes ni completes con suposiciones ningún dato de una acción (fecha, hora, número de confirmación) que no venga explícitamente en el resultado real de la herramienta.`.trim();

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
    private readonly externalData: ExternalDataResolver,
  ) {}
  async buildConversationPrompt(
    botConfigId: string,
    input: PromptBuildInput,
  ): Promise<BuiltPrompt> {
    const [settings, template, assembled, external] = await Promise.all([
      this.settingsRepo.findByBot(botConfigId),
      this.templates.findActive(botConfigId, PromptTemplateType.CONVERSATION),
      this.knowledge.assemble(botConfigId),
      this.externalData.resolve(botConfigId),
    ]);

    const vars = this.variables.resolve(settings);
    let systemPrompt = this.renderer.render(template, vars);

    if (assembled.compiled) {
      systemPrompt = `${systemPrompt}\n\nConocimiento:\n${assembled.compiled}`;
    }

    const { block } = this.contextBuilder.build(input.context, input.summary);
    if (block) systemPrompt = `${systemPrompt}\n\n${block}`;

    if (external.compiledBlock) {
      systemPrompt = `${systemPrompt}\n\n${external.compiledBlock}`;
    }

    if (input.history.length > 1) {
      const narrative = this.contextBuilder.buildHistoryNarrative(
        input.history,
      );
      if (narrative) systemPrompt = `${systemPrompt}\n\n${narrative}`;
    }

    if (input.hasTools) {
      systemPrompt = `${systemPrompt}\n\n${TOOL_RESULT_DISCIPLINE}`;
    }

    this.logger.debug(
      `Prompt built | ~${Math.ceil(systemPrompt.length / 4)} tokens` +
        (input.hasTools ? ' | tool discipline: on' : ''),
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
