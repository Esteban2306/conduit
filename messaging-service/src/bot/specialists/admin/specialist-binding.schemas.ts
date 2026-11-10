import { z } from 'zod';
import {
  BINDING_MODES,
  safeText,
  DEFAULT_TIMEOUT_MS,
  FAILURE_POLICIES,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
} from '../contracts';

export const upsertBindingSchema = z
  .object({
    specialistId: z.string().uuid(),
    mode: z.enum(BINDING_MODES).default('OFF'),
    timeoutMs: z
      .number()
      .int()
      .min(MIN_TIMEOUT_MS)
      .max(MAX_TIMEOUT_MS)
      .default(DEFAULT_TIMEOUT_MS),
    onFailure: z.enum(FAILURE_POLICIES).default('DEGRADE'),
    blockMessage: safeText(300).min(1).nullable().optional(),
  })
  .strict();
export type UpsertBindingInput = z.infer<typeof upsertBindingSchema>;
