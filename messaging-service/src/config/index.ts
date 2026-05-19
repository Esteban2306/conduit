import * as Joi from 'joi'

export const configValidationSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'production', 'test').default('development'),
  PORT: Joi.number().default(3001),
  API_SECRET_KEY: Joi.string().required(),

  DATABASE_URL: Joi.string().required(),

  REDIS_HOST: Joi.string().default('localhost'),
  REDIS_PORT: Joi.number().default(6379),

  DEFAULT_TENANT_ID: Joi.string().default('default'),

  RESEND_API_KEY: Joi.string().optional(),
  RESEND_FROM_EMAIL: Joi.string().email().optional(),
  RESEND_FROM_NAME: Joi.string().optional(),

  SMTP_HOST: Joi.string().optional(),
  SMTP_PORT: Joi.number().optional(),
  SMTP_USER: Joi.string().optional(),
  SMTP_PASS: Joi.string().optional(),
  SMTP_FROM_EMAIL: Joi.string().email().optional(),
  SMTP_FROM_NAME: Joi.string().optional(),

  WA_CHANNEL_MODE: Joi.string().valid('baileys', 'greenapi', 'walink').default('baileys'),
  GREEN_API_INSTANCE_ID: Joi.string().optional(),
  GREEN_API_TOKEN: Joi.string().optional(),

  WEBHOOK_SIGNING_SECRET: Joi.string().required(),

  QUEUE_MAX_ATTEMPTS: Joi.number().default(5),
  QUEUE_BACKOFF_DELAY: Joi.number().default(120000),
})

export interface AppConfig {
  app: {
    nodeEnv: string
    port: number | unknown
    apiSecretKey: string
  }
  database: {
    url: string
  }
  redis: {
    host: string
    port: number
  }
  tenant: {
    defaultId: string
  }
  resend: {
    apiKey: string
    fromEmail: string
    fromName: string
  }
  smtp: {
    host: string
    port: number
    user: string
    pass: string
    fromEmail: string
    fromName: string
  }
  whatsapp: {
    channelMode: 'baileys' | 'greenapi' | 'walink'
    greenApiInstanceId: string
    greenApiToken: string
  }
  webhook: {
    signingSecret: string
  }
  queue: {
    maxAttempts: number
    backoffDelay: number
  }
}

// Factory que NestJS usa internamente para construir el objeto de config
export const configFactory = (): AppConfig => ({
  app: {
    nodeEnv: process.env.NODE_ENV ?? '',
    port: parseInt(process.env.PORT ?? '', 10),
    apiSecretKey: process.env.API_SECRET_KEY ?? '',
  },
  database: {
    url: process.env.DATABASE_URL ?? '',
  },
  redis: {
    host: process.env.REDIS_HOST ?? '',
    port: parseInt(process.env.REDIS_PORT ?? '', 10),
  },
  tenant: {
    defaultId: process.env.DEFAULT_TENANT_ID ?? '',
  },
  resend: {
    apiKey: process.env.RESEND_API_KEY ?? '',
    fromEmail: process.env.RESEND_FROM_EMAIL ?? '',
    fromName: process.env.RESEND_FROM_NAME ?? '',
  },
  smtp: {
    host: process.env.SMTP_HOST ?? '',
    port: parseInt(process.env.SMTP_PORT ?? '', 10),
    user: process.env.SMTP_USER ?? '',
    pass: process.env.SMTP_PASS ?? '',
    fromEmail: process.env.SMTP_FROM_EMAIL ?? '',
    fromName: process.env.SMTP_FROM_NAME ?? '',
  },
  whatsapp: {
    channelMode: process.env.WA_CHANNEL_MODE as 'baileys' | 'greenapi' | 'walink',
    greenApiInstanceId: process.env.GREEN_API_INSTANCE_ID ?? '',
    greenApiToken: process.env.GREEN_API_TOKEN ?? '',
  },
  webhook: {
    signingSecret: process.env.WEBHOOK_SIGNING_SECRET ?? '',
  },
  queue: {
    maxAttempts: parseInt(process.env.QUEUE_MAX_ATTEMPTS ?? '', 10),
    backoffDelay: parseInt(process.env.QUEUE_BACKOFF_DELAY ?? '', 10),
  },
})