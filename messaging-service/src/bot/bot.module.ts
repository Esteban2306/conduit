import { forwardRef, Module } from '@nestjs/common';
import { BotConfigService } from './config/BotConfigService';
import { BotConfigController } from './config/BotConfigController';
import { AiModelSelectorService } from './AiModelSelectorService';
import { ConversationService } from './conversation/ConversationService';
import { BotRouter } from './router/BotRouter';
import { ChannelsModule } from 'src/channels/channels.module';
import { EventModule } from 'src/infra/events/event.module';

@Module({
  imports: [forwardRef(() => ChannelsModule), EventModule],
  controllers: [BotConfigController],
  providers: [
    BotConfigService,
    AiModelSelectorService,
    ConversationService,
    BotRouter,
  ],
  exports: [
    BotConfigService,
    AiModelSelectorService,
    ConversationService,
    BotRouter,
  ],
})
export class BotModule {}
