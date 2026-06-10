import { Module } from '@nestjs/common';
import { BotConfigService } from './config/BotConfigService';
import { BotConfigController } from './config/BotConfigController';
import { AiModelSelectorService } from './AiModelSelectorService';
import { ConversationService } from './conversation/ConversationService';

@Module({
  controllers: [BotConfigController],
  providers: [BotConfigService, AiModelSelectorService, ConversationService],
  exports: [BotConfigService, AiModelSelectorService, ConversationService],
})
export class BotModule {}
