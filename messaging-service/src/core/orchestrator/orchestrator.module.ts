import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { MessageOrchestrator } from './MessageOrchestrator';
import { MessageController } from './message.controller';
import { QUEUE_NAMES } from 'src/queue/queues';
import { TemplateModule } from 'src/core/templates/template.module';

@Module({
  imports: [
    BullModule.registerQueue(
      { name: QUEUE_NAMES.MESSAGES },
      { name: QUEUE_NAMES.MESSAGES_SCHEDULED },
    ),
    TemplateModule,
  ],
  controllers: [MessageController],
  providers: [MessageOrchestrator],
  exports: [MessageOrchestrator],
})
export class OrchestratorModule {}
