import { Module } from '@nestjs/common';
import { BotConfigService } from './BotConfigService';
import { BotConfigController } from './BotConfigController';
import { AuthModule } from 'src/auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [BotConfigController],
  providers: [BotConfigService],
  exports: [BotConfigService],
})
export class BotConfigModule {}
