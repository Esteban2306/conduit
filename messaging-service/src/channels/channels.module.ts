import { forwardRef, Module, OnModuleInit } from '@nestjs/common';
import { GmailResendPlugin } from './email/resend/GmailResendPlugin';
import { SmtpPlugin } from './email/smtp/SmtpBrevoPlugin';
import { BaileysPlugin } from './whatsapp/baileys/BaileysPlugin';
import { BaileysRateLimiter } from './whatsapp/baileys/BaileysRateLimiter';
import { ChannelRouter } from './router/ChannelRouter';
import { ChannelPluginFactory } from './factories/ChannelPluginFactory';
import { BaileysSessionManager } from './whatsapp/baileys/BaileysSessionManager';
import { BotRouter } from 'src/bot/router/BotRouter';
import { BotModule } from 'src/bot/bot.module';
import { EventModule } from 'src/infra/events/event.module';
import { BaileysMessageSender } from './whatsapp/baileys/BaileysMessageSender';
import { messageReceiptTracker } from './whatsapp/baileys/MessageReceiptTracker';

@Module({
  imports: [forwardRef(() => BotModule), EventModule],
  providers: [
    GmailResendPlugin,
    SmtpPlugin,
    BaileysPlugin,
    BaileysRateLimiter,
    ChannelRouter,
    BaileysMessageSender,
    ChannelPluginFactory,
    BaileysSessionManager,
    messageReceiptTracker,
  ],
  exports: [
    ChannelPluginFactory,
    ChannelRouter,
    BaileysPlugin,
    BaileysMessageSender,
    BaileysSessionManager,
    messageReceiptTracker,
  ],
})
export class ChannelsModule implements OnModuleInit {
  constructor(
    private readonly sessionManager: BaileysSessionManager,
    private readonly botRouter: BotRouter,
  ) {}

  onModuleInit() {
    this.sessionManager.setBotRouter(this.botRouter);
  }
}
