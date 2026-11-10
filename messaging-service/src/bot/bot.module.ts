import { WebhookModule } from 'src/webhooks/webhook.module';
import { Module } from '@nestjs/common';
import { BotConfigModule } from './config/BotConfig.module';
import { AiModelSelectorService } from './ai/AiModelSelectorService';
import { AiProviderFactory } from './ai/AiProviderFactory';
import { AiOrchestrator } from './ai/AiOrchestrator';
import { AiModelController } from './ai/AiModel.controller';
import { AnthropicProvider } from './ai/providers/AnthropicProvider';
import { OpenAIProvider } from './ai/providers/OpenAIProvider';
import { GeminiProvider } from './ai/providers/GeminiProvider';
import { GroqProvider } from './ai/providers/GroqProvider';
import { MistralProvider } from './ai/providers/MistralProvider';
import { CustomProvider } from './ai/providers/CustomProvider';
import { ConversationService } from './conversation/ConversationService';
import { ConversationSummarizer } from './conversation/ConversationSummarizer';
import { ProactiveMessageRecorder } from './conversation/ProactiveMessageRecorder';
import { BotRouter } from './router/BotRouter';
import { ChannelsModule } from 'src/channels/channels.module';
import { forwardRef } from '@nestjs/common';
import { ImageAnalysisService } from './ai/ImageAnalysisService';
import { LegacyImageUsageService } from './ai/LegacyImageUsage.service';
import { LegacyImageUsageController } from './ai/LegacyImageUsage.controller';
import { SpecialistRuntime } from './specialists/SpecialistRuntime';
import { VerificationLedger } from './specialists/VerificationLedger';
import { GroundingResolver } from './specialists/GroundingResolver';
import { SpecialistAdminService } from './specialists/admin/SpecialistAdminService';
import { SpecialistController } from './specialists/admin/Specialist.controller';
import { SpecialistModelService } from './specialists/admin/SpecialistModelService';
import { SpecialistModelController } from './specialists/admin/SpecialistModel.controller';
import { SpecialistBindingService } from './specialists/admin/SpecialistBindingService';
import { SpecialistBindingController } from './specialists/admin/SpecialistBinding.controller';
import { SpecialistVerificationService } from './specialists/admin/SpecialistVerificationService';
import { SpecialistMetricsService } from './specialists/admin/SpecialistMetricsService';
import { SpecialistVerificationController } from './specialists/admin/SpecialistVerification.controller';
import { MessageDebouncer } from './router/MessageDebouncer';
import { ReplyMetricsService } from './router/reply-metrics.service';
import { ImagePrefetchService } from './router/ImagePrefetch.service';
import { OpenRouterProvider } from './ai/providers/OpenRouterProvider';
import { PromptModule } from './prompt/Prompt.module';
import { ToolDefinitionService } from './tools/ToolDefinitionService';
import { ToolExecutorService } from './tools/ToolExecutor.service';
import { HandoffService } from './handoff/Handoff.service';
import { HardRulesService } from './intent/HardRules.service';
import { IntentAiClassifier } from './intent/IntentAiClassifier';
import { IntentRepository } from './intent/IntentRepository.service';
import { IntentHandler } from './intent/IntentHandler';
import { IntentResolver } from './intent/IntentResolver';
import { IntentMetricsService } from './intent/intent-metrics.service';
import { IntentController } from './intent/Intent.controller';
import { AiOutageDigestService } from './tools/AiOutageDigest.service';
import { BotEscalationService } from './tools/BotEscalation.service';
import { SecurityModule } from 'src/shared/security/security.module';
import { WhatsAppContactModule } from 'src/channels/whatsapp/contacts/whatsapp-contact.module';
import { OrchestratorModule } from 'src/core/orchestrator/orchestrator.module';
import { AiErrorClassifier } from './ai/AiErrorClassifier';
import { ToolDefinitionController } from './tools/ToolDefinition.controller';
import { ConversationAdminController } from './admin/ConversationAdmin.controller';
import { SystemPauseController } from './pause/SystemPause.controller';
import { SystemPauseService } from './pause/SystemPause.service';

@Module({
  imports: [
    BotConfigModule,
    forwardRef(() => ChannelsModule),
    PromptModule,
    SecurityModule,
    OrchestratorModule,
    WhatsAppContactModule,
    WebhookModule,
  ],
  controllers: [
    AiModelController,
    ToolDefinitionController,
    ConversationAdminController,
    IntentController,
    SystemPauseController,
    SpecialistController,
    SpecialistModelController,
    SpecialistBindingController,
    SpecialistVerificationController,
    LegacyImageUsageController,
  ],
  providers: [
    SystemPauseService,
    ConversationService,
    ConversationSummarizer,
    ProactiveMessageRecorder,
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
    LegacyImageUsageService,
    SpecialistRuntime,
    VerificationLedger,
    GroundingResolver,
    SpecialistAdminService,
    SpecialistModelService,
    SpecialistBindingService,
    SpecialistVerificationService,
    SpecialistMetricsService,
    MessageDebouncer,
    ReplyMetricsService,
    ImagePrefetchService,
    ToolDefinitionService,
    ToolExecutorService,
    BotEscalationService,
    AiOutageDigestService,
    IntentResolver,
    IntentRepository,
    HardRulesService,
    HandoffService,
    IntentAiClassifier,
    IntentMetricsService,
    IntentHandler,
    AiErrorClassifier,
  ],
  exports: [
    BotConfigModule,
    ConversationService,
    BotRouter,
    AiOrchestrator,
    AiModelSelectorService,
    SpecialistRuntime,
    VerificationLedger,
    MessageDebouncer,
    ReplyMetricsService,
    IntentMetricsService,
  ],
})
export class BotModule {}
