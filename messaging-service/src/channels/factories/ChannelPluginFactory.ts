import { Injectable } from '@nestjs/common';
import { MessageChannel } from '@prisma/client';
import { ChannelRouter } from '../router/ChannelRouter';
import { ConfigService } from '@nestjs/config';
import { ChannelPreference, IChannelPlugin } from '../types/IChannelPlugin';

export interface ResolvedChannels {
  plugin: Array<{ plugin: IChannelPlugin; channel: string }>;
}

@Injectable()
export class ChannelPluginFactory {
  constructor(
    private readonly router: ChannelRouter,
    private readonly config: ConfigService,
  ) {}

  resolveForMessage(
    defaultChannel: MessageChannel,
    recipientAddress?: string,
    preferences?: ChannelPreference[],
  ): ResolvedChannels {
    if (!preferences || preferences.length === 0) {
      const plugin = this.router.resolve(defaultChannel, recipientAddress);
      return { plugin: [{ plugin, channel: defaultChannel }] };
    }
    const sorted = [...preferences].sort(
      (a, b) => (a.priority ?? 99) - (b.priority ?? 99),
    );

    const plugin = sorted.map((pref) => {
      const channel = pref.channel as unknown as MessageChannel;

      if (channel === MessageChannel.WHATSAPP) {
        const mode =
          this.config.get<string>('whatsapp.channelMode') ?? 'baileys';
        this.validateWhatsappMode(mode);
      }

      return {
        plugin: this.router.resolve(channel, recipientAddress),
        channel: pref.channel,
      };
    });
    return { plugin };
  }

  getPlugin(channel: MessageChannel): IChannelPlugin {
    if (channel === MessageChannel.WHATSAPP) {
      const mode = this.config.get<string>('whatsapp.channelMode') ?? 'baileys';
      this.validateWhatsappMode(mode);
    }

    return this.router.resolve(channel);
  }

  private validateWhatsappMode(mode: string): void {
    const supported = ['baileys', 'greenapi', 'walink'];
    if (!supported.includes(mode)) {
      throw new Error(
        `WA_CHANNEL_MODE inválido: ${mode}. Opciones: ${supported.join(', ')}`,
      );
    }
  }
}
