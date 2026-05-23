import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { Resend } from 'resend';

import {
  ChannelSendPayload,
  ChannelSendResult,
  IChannelPlugin,
} from 'src/channels/types/IChannelPlugin';

@Injectable()
export class GmailResendPlugin implements IChannelPlugin {
    readonly channel = 'email'
    readonly providerName: 'resend'

    private readonly resend: Resend
    private readonly logger = new Logger(GmailResendPlugin.name)

    constructor(
        private readonly config: ConfigService
    ) {
        this.resend = new Resend(
            this.config.get('resend.apiKey')
        )
    }

    validateRecipient(address: string): boolean {
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)
    }

    async send(
        payload: ChannelSendPayload
    ): Promise<ChannelSendResult> {
        try {
            const response = await this.resend.emails.send({
                from: `${this.config.get('resend.fromName')} <${this.config.get('resend.fromEmail')}>`,
                to: payload.to,
                subject: payload.subject || '(Sin asunto)',
                html: payload.content
            })
            return {
                success: true,
                provider: this.providerName,
                providerMessageId: response.data?.id,
                raw: response
            }
        } catch (error) {
            return {
                success: false,
                provider: this.providerName,
                retryable: true,
                error: error instanceof Error ? error.message : 'Unknown error',
                errorCode: error instanceof Error ? error.name : 'Unknown error code',
                raw: error
            }
        }
    }

}
