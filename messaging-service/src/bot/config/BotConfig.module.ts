import { Module } from '@nestjs/common';
import { BotConfigService } from './BotConfigService';
import { BotConfigController } from './BotConfigController';
import { AiKeyEncryptionMigration } from './AiKeyEncryptionMigration';
import { AuthModule } from 'src/auth/auth.module';
import { SecurityModule } from 'src/shared/security/security.module';

@Module({
  imports: [AuthModule, SecurityModule],
  controllers: [BotConfigController],
  providers: [BotConfigService, AiKeyEncryptionMigration],
  exports: [BotConfigService],
})
export class BotConfigModule {}
