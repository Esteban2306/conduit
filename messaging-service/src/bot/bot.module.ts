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

@Module({
  imports: [forwardRef(() => ChannelsModule)],
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
    MistralProvider,
    CustomProvider,
  ],
  exports: [
    BotConfigService,
    ConversationService,
    BotRouter,
    AiOrchestrator,
    AiModelSelectorService,
  ],
})
export class BotModule {}
