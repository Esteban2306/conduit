import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  IChannelPlugin,
  ChannelSendPayload,
  ChannelSendResult,
} from 'src/channels/types/IChannelPlugin';

import * as nodemailer from 'nodemailer';

@Injectable()
export class SmtpPlugin implements IChannelPlugin {
  readonly channel = 'SMTP';
  readonly providerName: 'smtp';

  private readonly logger = new Logger(SmtpPlugin.name);
  private readonly transporter: nodemailer.Transporter;

  constructor(private readonly config: ConfigService) {
    this.transporter = nodemailer.createTransport({
      host: this.config.get<string>('smtp.host'),
      port: this.config.get<number>('smtp.port'),
      secure: false,
      auth: {
        user: this.config.get<string>('smtp.user'),
        pass: this.config.get<string>('smtp.pass'),
      },
    });
  }

  validateRecipient(address: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address);
  }

  async send(payload: ChannelSendPayload): Promise<ChannelSendResult> {
    try {
      const response = await this.transporter.sendMail({
        from: {
          name: this.config.get('smtp.fromName'),
          address: this.config.get('smtp.fromEmail'),
        },
        to: payload.to,

        subject: payload.subject,

        html: payload.content,
      });

      return {
        success: true,
        provider: this.providerName,
        providerMessageId: response.messageId,
        raw: response,
      };
    } catch (error) {
      const isNetworkError =
        error?.code === 'ECONNREFUSED' || error?.code === 'ETIMEDOUT';
      this.logger.error(`SMTP error: ${error?.message}`, error);

      return {
        success: false,
        provider: this.providerName,
        retryable: isNetworkError,
        errorCode: isNetworkError
          ? 'NETWORK_ERROR'
          : 'PERMANENT_DELIVERY_FAILURE',
        error: error instanceof Error ? error.message : 'Unknown error',
        raw: error,
      };
    }
  }
}
