import { Module } from '@nestjs/common';
import { WebhookDispatcher } from './WebhookDispatcher';
import { WebhookService } from './Webhook.service';
import { WebhookController } from './Webhook.controller';

@Module({
  controllers: [WebhookController],
  providers: [WebhookDispatcher, WebhookService],
  exports: [WebhookDispatcher, WebhookService],
})
export class WebhookModule {}
