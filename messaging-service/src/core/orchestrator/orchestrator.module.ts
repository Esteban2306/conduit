import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { MessageOrchestrator } from './MessageOrchestrator';
import { MessageController } from './message.controller';
import { QUEUE_NAMES } from 'src/queue/queues';
import { TemplateModule } from 'src/core/templates/template.module';
import { FileParserService } from '../adapters/FileParserService';
import { JobSigner } from 'src/queue/security/JobSigner';

@Module({
  imports: [
    BullModule.registerQueue(
      { name: QUEUE_NAMES.MESSAGES },
      { name: QUEUE_NAMES.MESSAGES_SCHEDULED },
    ),
    TemplateModule,
  ],
  controllers: [MessageController],
  providers: [MessageOrchestrator, FileParserService, JobSigner],
  exports: [MessageOrchestrator],
})
export class OrchestratorModule {}
