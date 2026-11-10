import { z } from 'zod';
import { capabilitySchema } from '../contracts';
import { MAX_RANGE_DAYS, MODE_VALUES } from './specialist-verification.schemas';

const id = z.string().min(1).max(64);
const isoDate = z.string().datetime({ offset: true });

export const DEFAULT_METRICS_DAYS = 7;
export const TOP_REASON_CODES = 20;

export const metricsQuerySchema = z
  .object({
    specialistId: id.optional(),
    botConfigId: id.optional(),
    capability: capabilitySchema.optional(),
    mode: z.enum(MODE_VALUES).optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
  })
  .strict()
  .refine(
    (value) =>
      !value.from ||
      !value.to ||
      new Date(value.from).getTime() <= new Date(value.to).getTime(),
    { message: '"from" no puede ser posterior a "to"' },
  )
  .refine(
    (value) =>
      !value.from ||
      !value.to ||
      new Date(value.to).getTime() - new Date(value.from).getTime() <=
        MAX_RANGE_DAYS * 86_400_000,
    { message: `El rango no puede superar ${MAX_RANGE_DAYS} días` },
  );
export type MetricsQuery = z.infer<typeof metricsQuerySchema>;
