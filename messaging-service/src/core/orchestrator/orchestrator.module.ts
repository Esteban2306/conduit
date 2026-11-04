import { Module } from '@nestjs/common';
import { MessageOrchestrator } from './MessageOrchestrator';
import { MessageController } from './message.controller';
import { registerMessageQueues } from 'src/queue/message-queues.registration';
import { TemplateModule } from 'src/core/templates/template.module';
import { FileParserService } from '../adapters/FileParserService';
import { JobSigner } from 'src/queue/security/JobSigner';
import { AuthModule } from 'src/auth/auth.module';
import { WebhookModule } from 'src/webhooks/webhook.module';
import { WhatsAppContactModule } from 'src/channels/whatsapp/contacts/whatsapp-contact.module';

@Module({
  imports: [
    registerMessageQueues(),
    TemplateModule,
    AuthModule,
    WebhookModule,
    WhatsAppContactModule,
  ],
  controllers: [MessageController],
  providers: [MessageOrchestrator, FileParserService, JobSigner],
  exports: [MessageOrchestrator],
})
export class OrchestratorModule {}
