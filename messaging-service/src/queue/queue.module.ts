import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { registerMessageQueues } from './message-queues.registration';
import { MessageWorker } from './BullMQ/workers/MessageWorker';
import { ScheduledMessageWorker } from './BullMQ/workers/ScheduledMessageWorker';
import { DLQHandler } from './Orchestrator/deadletter/DLQHandler';
import { ChannelsModule } from 'src/channels/channels.module';
import { TemplateModule } from 'src/core/templates/template.module';
import { MessageProcessor } from './processors/MessageProcessor';
import { WebhookModule } from 'src/webhooks/webhook.module';
import { JobSigner } from './security/JobSigner';
import { MessageRecoveryService } from './recovery/MessageRecoveryService';
import { DeadLetterController } from './Orchestrator/deadletter/DeadLetter.controller';
import { AuthModule } from 'src/auth/auth.module';

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
    registerMessageQueues(),
    ChannelsModule,
    TemplateModule,
    WebhookModule,
    AuthModule,
  ],
  controllers: [DeadLetterController],
  providers: [
    MessageWorker,
    MessageProcessor,
    ScheduledMessageWorker,
    DLQHandler,
    JobSigner,
    MessageRecoveryService,
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
