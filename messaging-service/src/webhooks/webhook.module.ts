import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { WebhookDispatcher } from './WebhookDispatcher';
import { WebhookService } from './Webhook.service';
import { WebhookController } from './Webhook.controller';
import { WebhookDeliveryWorker } from './WebhookDeliveryWorker';
import { AuthModule } from 'src/auth/auth.module';
import { QUEUE_NAMES } from 'src/queue/queues';

@Module({
  imports: [
    AuthModule,
    BullModule.registerQueue({
      name: QUEUE_NAMES.WEBHOOKS,
      defaultJobOptions: {
        // 30 s, 1, 2, 4, 8, 16, 32 min: ~1 h cubriendo caídas del receptor.
        attempts: 8,
        backoff: { type: 'exponential', delay: 30_000 },
        removeOnComplete: { count: 1000 },
        removeOnFail: { age: 7 * 24 * 60 * 60 },
      },
    }),
  ],
  controllers: [WebhookController],
  providers: [WebhookDispatcher, WebhookService, WebhookDeliveryWorker],
  exports: [WebhookDispatcher, WebhookService],
})
export class WebhookModule {}
