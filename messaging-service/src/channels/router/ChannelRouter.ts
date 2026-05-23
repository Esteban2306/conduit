import { Injectable } from '@nestjs/common';
import { MessageChannel } from '@prisma/client';
import { GmailResendPlugin } from '../email/resend/GmailResendPlugin';
import { SmtpPlugin } from '../email/smtp/SmtpBrevoPlugin';
import { BaileysPlugin } from '../whatsapp/baileys/BaileysPlugin';
import { ConfigService } from '@nestjs/config';
import { IChannelPlugin } from '../types/IChannelPlugin';

@Injectable()
export class ChannelRouter {
  private readonly pluginMap: Map<string, IChannelPlugin>;
  private readonly RESEND_DOMAINS = ['gmail.com', 'googlemail.com'];

  constructor(
    private readonly resend: GmailResendPlugin,
    private readonly smtp: SmtpPlugin,
    private readonly baileys: BaileysPlugin,
  ) {
    this.pluginMap = new Map<string, IChannelPlugin>([
      [MessageChannel.EMAIL, this.resend],
      [MessageChannel.SMTP, this.smtp],
      [MessageChannel.WHATSAPP, this.baileys],
    ]);
  }

  resolve(channel: MessageChannel, recipientAddress?: string): IChannelPlugin {
    if (channel === MessageChannel.EMAIL && recipientAddress) {
      return this.resolveEmailPlugin(recipientAddress);
    }

    const plugin = this.pluginMap.get(channel);
    if (!plugin) {
      throw new Error(`Plugin no encontrado para el canal: ${channel}`);
    }
    return plugin;
  }

  private resolveEmailPlugin(address: string): IChannelPlugin {
    const domain = address.split('@')[1]?.toLowerCase();
    if (!domain) return this.resend;

    const useResend = this.RESEND_DOMAINS.includes(domain);
    return useResend ? this.resend : this.smtp;
  }

  getAvailableChannels(): string[] {
    return Array.from(this.pluginMap.keys());
  }
}
