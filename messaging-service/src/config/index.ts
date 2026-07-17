import * as Joi from 'joi';

export const configValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),
  PORT: Joi.number().default(3001),
  API_SECRET_KEY: Joi.string().required(),
  FRONTEND_URL: Joi.string().uri().default('http://localhost:3000'),

  JWT_SECRET: Joi.string().min(32).required(),

  DATABASE_URL: Joi.string().required(),

  REDIS_HOST: Joi.string().default('localhost'),
  REDIS_PORT: Joi.number().default(6379),

  DEFAULT_TENANT_ID: Joi.string().default('default'),

  RESEND_API_KEY: Joi.string().optional(),
  RESEND_FROM_EMAIL: Joi.string().email().optional(),
  RESEND_FROM_NAME: Joi.string().optional(),

  SMTP_HOST: Joi.string().optional(),
  SMTP_PORT: Joi.number().default(587),
  SMTP_USER: Joi.string().optional(),
  SMTP_PASS: Joi.string().optional(),
  SMTP_FROM_EMAIL: Joi.string().email().optional(),
  SMTP_FROM_NAME: Joi.string().optional(),

  WA_CHANNEL_MODE: Joi.string()
    .valid('baileys', 'greenapi', 'walink')
    .default('baileys'),
  warmupLevel: Joi.string()
    .valid('FRESH', 'NORMAL', 'TRUSTED')
    .default('NORMAL'),
  WA_SESSION_PATH: Joi.string().default('./baileys_session'),
  GREEN_API_INSTANCE_ID: Joi.string().optional(),
  GREEN_API_TOKEN: Joi.string().optional(),

  INTEGRATION_ENCRYPTION_KEY: Joi.string().hex().length(64).required(),

  QUEUE_MAX_ATTEMPTS: Joi.number().default(5),
  QUEUE_BACKOFF_DELAY: Joi.number().default(120000),
});

export interface AppConfig {
  app: {
    nodeEnv: string;
    port: number;
    apiSecretKey: string;
    frontendUrl: string;
  };
  jwt: {
    secret: string;
  };
  database: {
    url: string;
  };
  redis: {
    host: string;
    port: number;
  };
  tenant: {
    defaultId: string;
  };
  resend: {
    apiKey: string;
    fromEmail: string;
    fromName: string;
  };
  smtp: {
    host: string;
    port: number;
    user: string;
    pass: string;
    fromEmail: string;
    fromName: string;
  };
  whatsapp: {
    channelMode: 'baileys' | 'greenapi' | 'walink';
    warmupLevel: string;
    greenApiInstanceId: string;
    greenApiToken: string;
    sessionPath: string;
  };
  webhook: {
    encryptionKey: string;
  };
  queue: {
    maxAttempts: number;
    backoffDelay: number;
  };
}

export const configFactory = (): AppConfig => ({
  app: {
    nodeEnv: process.env.NODE_ENV ?? '',
    port: parseInt(process.env.PORT ?? '3001', 10),
    apiSecretKey: process.env.API_SECRET_KEY ?? '',
    frontendUrl: process.env.FRONTEND_URL ?? 'http://localhost:3000',
  },
  jwt: {
    secret: process.env.JWT_SECRET ?? '',
  },
  database: {
    url: process.env.DATABASE_URL ?? '',
  },
  redis: {
    host: process.env.REDIS_HOST ?? '',
    port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
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
    port: parseInt(process.env.SMTP_PORT ?? '587', 10),
    user: process.env.SMTP_USER ?? '',
    pass: process.env.SMTP_PASS ?? '',
    fromEmail: process.env.SMTP_FROM_EMAIL ?? '',
    fromName: process.env.SMTP_FROM_NAME ?? '',
  },
  whatsapp: {
    channelMode: process.env.WA_CHANNEL_MODE as
      | 'baileys'
      | 'greenapi'
      | 'walink',
    greenApiInstanceId: process.env.GREEN_API_INSTANCE_ID ?? '',
    warmupLevel: process.env.WA_WARMUP_LEVEL ?? 'NORMAL',
    greenApiToken: process.env.GREEN_API_TOKEN ?? '',
    sessionPath: process.env.WA_SESSION_PATH ?? './baileys_session',
  },
  webhook: {
    encryptionKey: process.env.INTEGRATION_ENCRYPTION_KEY ?? '',
  },
  queue: {
    maxAttempts: parseInt(process.env.QUEUE_MAX_ATTEMPTS ?? '5', 10),
    backoffDelay: parseInt(process.env.QUEUE_BACKOFF_DELAY ?? '120000', 10),
  },
});
