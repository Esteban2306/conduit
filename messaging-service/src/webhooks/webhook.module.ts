import { Module } from '@nestjs/common';
import { WebhookDispatcher } from './WebhookDispatcher';
import { WebhookService } from './WebhookService';

@Module({
  providers: [WebhookDispatcher, WebhookService],
  exports: [WebhookDispatcher, WebhookService],
})
export class WebhookModule {}
