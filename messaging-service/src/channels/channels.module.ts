import { forwardRef, Module, OnModuleInit } from '@nestjs/common';
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
import { WhatsAppConnectionOrchestrator } from './whatsapp/WhatsAppConnectionOrchestrator';
import { BotSentMessageRegistry } from 'src/channels/whatsapp/baileys/BotSentMessageRegistry';
import { AuthModule } from 'src/auth/auth.module';

@Module({
  imports: [forwardRef(() => BotModule), EventModule, AuthModule],
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
    BaileysSessionManager,
    WhatsAppConnectionService,
    messageReceiptTracker,
    BotSentMessageRegistry,
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
  constructor(
    private readonly sessionManager: BaileysSessionManager,
    private readonly botRouter: BotRouter,
    private readonly connections: WhatsAppConnectionService,
  ) {}

  async onModuleInit() {
    this.sessionManager.setBotRouter(this.botRouter);

    const connections = await this.connections.findConnectionsToRestore();
    await Promise.all(
      connections.map(({ id }) =>
        this.sessionManager.start(id).catch(() => {}),
      ),
    );
  }
}
