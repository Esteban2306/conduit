import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { QUEUE_NAMES } from './queues';
import { MessageWorker } from './BullMQ/workers/MessageWorker';
import { ScheduledMessageWorker } from './BullMQ/workers/ScheduledMessageWorker';
import { DLQHandler } from './Orchestrator/deadletter/DLQHandler';
import { ChannelsModule } from 'src/channels/channels.module';
import { TemplateModule } from 'src/core/templates/template.module';
import { MessageProcessor } from './processors/MessageProcessor';
import { WebhookModule } from 'src/webhooks/webhook.module';
import { JobSigner } from './security/JobSigner';

@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.get<string>('redis.host'),
          port: config.get<number>('redis.port'),
        },
      }),
      inject: [ConfigService],
    }),
    BullModule.registerQueue(
      { name: QUEUE_NAMES.MESSAGES },
      { name: QUEUE_NAMES.MESSAGES_SCHEDULED },
      { name: QUEUE_NAMES.DEAD_LETTER },
    ),
    ChannelsModule,
    TemplateModule,
    WebhookModule,
  ],
  providers: [
    MessageWorker,
    MessageProcessor,
    ScheduledMessageWorker,
    DLQHandler,
    JobSigner,
  ],
  exports: [
    MessageWorker,
    ScheduledMessageWorker,
    DLQHandler,
    BullModule,
    JobSigner,
  ],
})
export class QueueModule {}
