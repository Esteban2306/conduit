import { MessageChannel } from "@prisma/client";

export interface TemplateVariables extends Record<string, unknown> {}

export interface MessageRecipient {
    channel: MessageChannel;
    address: string;
    name?: string
}

export interface InlineTemplate {
    subject?: string;
    body: string;
}

export interface MessagePayload {
    recipient: MessageRecipient
    template: {
        id?: string
        inline?: InlineTemplate
    }
    variables: TemplateVariables
    options?: {
        sheduleAt?: string
        priority?: 'low' | 'normal' | 'high'
        webhookUrl?: string
    }
    meta?: Record<string, unknown>
}