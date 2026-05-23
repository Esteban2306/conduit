import { Module } from '@nestjs/common';
import { GmailResendPlugin } from './email/resend/GmailResendPlugin';
import { SmtpPlugin } from './email/smtp/SmtpBrevoPlugin';
import { BaileysPlugin } from './whatsapp/baileys/BaileysPlugin';
import { BaileysRateLimiter } from './whatsapp/baileys/BaileysRateLimiter';
import { ChannelRouter } from './router/ChannelRouter';
import { ChannelPluginFactory } from './factories/ChannelPluginFactory';
import { BaileysSessionManager } from './whatsapp/baileys/BaileysSessionManager';

@Module({
  providers: [
    GmailResendPlugin,
    SmtpPlugin,
    BaileysPlugin,
    BaileysRateLimiter,
    ChannelRouter,
    ChannelPluginFactory,
    BaileysSessionManager,
  ],
  exports: [ChannelPluginFactory, ChannelRouter],
})
export class ChannelsModule {}
