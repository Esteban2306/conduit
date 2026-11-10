import { WhatsAppSessionEncryptionMigration } from './whatsapp/baileys/WhatsAppSessionEncryptionMigration';
import { SecurityModule } from 'src/shared/security/security.module';
import { OutboundReplyService } from './whatsapp/outbox/OutboundReply.service';
import { OutboundReplyDispatcher } from './whatsapp/outbox/OutboundReplyDispatcher';
import { OpsWatchdogService } from './whatsapp/alerts/OpsWatchdog.service';
import { registerMessageQueues } from 'src/queue/message-queues.registration';
import { OpsAlertService } from './whatsapp/alerts/OpsAlert.service';
import { WebhookModule } from 'src/webhooks/webhook.module';
import { OrchestratorModule } from 'src/core/orchestrator/orchestrator.module';
import { forwardRef, Logger, Module, OnModuleInit } from '@nestjs/common';
import { GmailResendPlugin } from './email/resend/GmailResendPlugin';
import { SmtpPlugin } from './email/smtp/SmtpBrevoPlugin';
import { BaileysPlugin } from './whatsapp/baileys/BaileysPlugin';
import { BaileysRateLimiterRegistry } from './whatsapp/baileys/BaileysRateLimiterRegistry';
import { ChannelRouter } from './router/ChannelRouter';
import { ChannelPluginFactory } from './factories/ChannelPluginFactory';
import { BaileysSessionManager } from './whatsapp/baileys/BaileysSessionManager';
import { BotRouter } from 'src/bot/router/BotRouter';
import { BotModule } from 'src/bot/bot.module';
import { EventModule } from 'src/infra/events/event.module';
import { BaileysMessageSender } from './whatsapp/baileys/BaileysMessageSender';
import { messageReceiptTracker } from './whatsapp/baileys/MessageReceiptTracker';
import { ConnectionController } from './whatsapp/Connection.controller';
import { WhatsAppConnectionService } from './whatsapp/WhatsAppConnection.service';
import { LineAdoptionService } from './whatsapp/LineAdoption.service';
import { NumberConflictHandler } from './whatsapp/NumberConflictHandler';
import { restoreSessions } from './whatsapp/restore-sessions';
import { WhatsAppConnectionOrchestrator } from './whatsapp/WhatsAppConnectionOrchestrator';
import { BotSentMessageRegistry } from 'src/channels/whatsapp/baileys/BotSentMessageRegistry';
import { AuthModule } from 'src/auth/auth.module';
import { WhatsAppContactModule } from './whatsapp/contacts/whatsapp-contact.module';
import { SentMessageStore } from './whatsapp/baileys/SentMessageStore';

@Module({
  imports: [
    forwardRef(() => BotModule),
    EventModule,
    AuthModule,
    WhatsAppContactModule,
    WebhookModule,
    OrchestratorModule,
    SecurityModule,
    registerMessageQueues(),
  ],
  controllers: [ConnectionController],
  providers: [
    GmailResendPlugin,
    SmtpPlugin,
    BaileysPlugin,
    BaileysRateLimiterRegistry,
    ChannelRouter,
    BaileysMessageSender,
    ChannelPluginFactory,
    WhatsAppConnectionOrchestrator,
    LineAdoptionService,
    NumberConflictHandler,
    BaileysSessionManager,
    WhatsAppConnectionService,
    messageReceiptTracker,
    BotSentMessageRegistry,
    SentMessageStore,
    OutboundReplyService,
    OutboundReplyDispatcher,
    WhatsAppSessionEncryptionMigration,
    OpsAlertService,
    OpsWatchdogService,
  ],
  exports: [
    ChannelPluginFactory,
    ChannelRouter,
    BaileysPlugin,
    BaileysMessageSender,
    BaileysSessionManager,
    WhatsAppConnectionService,
    messageReceiptTracker,
    BotSentMessageRegistry,
  ],
})
export class ChannelsModule implements OnModuleInit {
  private readonly logger = new Logger(ChannelsModule.name);

  constructor(
    private readonly sessionManager: BaileysSessionManager,
    private readonly botRouter: BotRouter,
    private readonly connections: WhatsAppConnectionService,
    private readonly numberConflicts: NumberConflictHandler,
  ) {}

  async onModuleInit() {
    this.sessionManager.setBotRouter(this.botRouter);
    this.sessionManager.setNumberConflictHandler(this.numberConflicts.handle);

    await restoreSessions(this.connections, this.sessionManager, this.logger);
  }
}
