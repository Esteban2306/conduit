import { Module } from '@nestjs/common';
import { BotConfigService } from './BotConfigService';
import { BotConfigController } from './BotConfigController';

@Module({
  controllers: [BotConfigController],
  providers: [BotConfigService],
  exports: [BotConfigService],
})
export class BotConfigModule {}
