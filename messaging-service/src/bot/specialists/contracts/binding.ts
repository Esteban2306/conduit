import { z } from 'zod';
import { capabilitySchema } from './keys';

export const BINDING_MODES = ['OFF', 'SHADOW', 'ACTIVE'] as const;
export const FAILURE_POLICIES = ['DEGRADE', 'BLOCK'] as const;

export const MIN_TIMEOUT_MS = 1000;
export const MAX_TIMEOUT_MS = 30000;
export const DEFAULT_TIMEOUT_MS = 12000;

export const bindingInputSchema = z
  .object({
    capability: capabilitySchema,
    specialistId: z.string().uuid(),
    mode: z.enum(BINDING_MODES).default('OFF'),
    timeoutMs: z
      .number()
      .int()
      .min(MIN_TIMEOUT_MS)
      .max(MAX_TIMEOUT_MS)
      .default(DEFAULT_TIMEOUT_MS),
    onFailure: z.enum(FAILURE_POLICIES).default('DEGRADE'),
  })
  .strict();
export type BindingInput = z.infer<typeof bindingInputSchema>;
