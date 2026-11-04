import { Prisma } from '@prisma/client';

export const AI_MODEL_PUBLIC_SELECT = {
  id: true,
  provider: true,
  model: true,
  baseUrl: true,
  role: true,
  tier: true,
  priority: true,
  isActive: true,
  dailyTokenLimit: true,
  minuteRequestLimit: true,
  tokensUsedToday: true,
  requestsThisMinute: true,
  unavailableUntil: true,
  credentialInvalidAt: true,
  consecutiveFailures: true,
  lastErrorType: true,
  lastErrorAt: true,
  apiKeyLast4: true,
  createdAt: true,
} satisfies Prisma.AiModelConfigSelect;

export type AiModelPublic = Prisma.AiModelConfigGetPayload<{
  select: typeof AI_MODEL_PUBLIC_SELECT;
}>;
