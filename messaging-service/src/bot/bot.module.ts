import { Module } from '@nestjs/common';
import { BotConfigModule } from './config/BotConfig.module';
import { AiModelSelectorService } from './ai/AiModelSelectorService';
import { AiProviderFactory } from './ai/AiProviderFactory';
import { AiOrchestrator } from './ai/AiOrchestrator';
import { AnthropicProvider } from './ai/providers/AnthropicProvider';
import { OpenAIProvider } from './ai/providers/OpenAIProvider';
import { GeminiProvider } from './ai/providers/GeminiProvider';
import { GroqProvider } from './ai/providers/GroqProvider';
import { MistralProvider } from './ai/providers/MistralProvider';
import { CustomProvider } from './ai/providers/CustomProvider';
import { ConversationService } from './conversation/ConversationService';
import { BotRouter } from './router/BotRouter';
import { ChannelsModule } from 'src/channels/channels.module';
import { forwardRef } from '@nestjs/common';
import { ImageAnalysisService } from './ai/ImageAnalysisService';
import { MessageDebouncer } from './router/MessageDebouncer';
import { OpenRouterProvider } from './ai/providers/OpenRouterProvider';
import { PromptModule } from './prompt/Prompt.module';
import { ToolDefinitionService } from './tools/ToolDefinitionService';
import { ToolExecutorService } from './tools/ToolExecutor.service';
import { BotEscalationService } from './tools/BotEscalation.service';
import { SecurityModule } from 'src/shared/security/security.module';
import { OrchestratorModule } from 'src/core/orchestrator/orchestrator.module';
import { AiErrorClassifier } from './ai/AiErrorClassifier';
import { ToolDefinitionController } from './tools/ToolDefinition.controller';

@Module({
  imports: [
    BotConfigModule,
    forwardRef(() => ChannelsModule),
    PromptModule,
    SecurityModule,
    OrchestratorModule,
  ],
  controllers: [ToolDefinitionController],
  providers: [
    ConversationService,
    BotRouter,
    AiModelSelectorService,
    AiProviderFactory,
    AiOrchestrator,
    AnthropicProvider,
    OpenAIProvider,
    GeminiProvider,
    GroqProvider,
    OpenRouterProvider,
    MistralProvider,
    CustomProvider,
    ImageAnalysisService,
    MessageDebouncer,
    ToolDefinitionService,
    ToolExecutorService,
    BotEscalationService,
    AiErrorClassifier,
  ],
  exports: [
    BotConfigModule,
    ConversationService,
    BotRouter,
    AiOrchestrator,
    AiModelSelectorService,
    MessageDebouncer,
  ],
})
export class BotModule {}
