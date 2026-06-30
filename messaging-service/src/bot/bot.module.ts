import { Module } from '@nestjs/common';
import { BotConfigService } from './config/BotConfigService';
import { BotConfigController } from './config/BotConfigController';
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
import { PromptEngine } from './prompt/PromptEngine';
import { PromptModule } from './prompt/Prompt.module';

@Module({
  imports: [forwardRef(() => ChannelsModule), PromptModule],
  controllers: [BotConfigController],
  providers: [
    BotConfigService,
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
  ],
  exports: [
    BotConfigService,
    ConversationService,
    BotRouter,
    AiOrchestrator,
    AiModelSelectorService,
    MessageDebouncer,
  ],
})
export class BotModule {}
