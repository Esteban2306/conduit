import { z } from 'zod';
import { AiModelTier, AiProvider } from '@prisma/client';
import { isPlaceholderKey } from 'src/bot/ai/AiModelSelectorService';
import { safeText } from '../contracts';

export const SPECIALIST_MODEL_ROLES = ['IMAGE_ANALYSIS', 'FALLBACK'] as const;

const apiKey = z
  .string()
  .trim()
  .min(20)
  .max(512)
  .refine((value) => !isPlaceholderKey(value), {
    message: 'La clave parece un valor de relleno, no una API key real',
  });

const baseUrl = z
  .string()
  .max(500)
  .url()
  .refine((value) => /^https?:\/\//i.test(value), {
    message: 'baseUrl debe empezar por http:// o https://',
  });

const limit = z.number().int().min(1).max(1_000_000_000);

export const createSpecialistModelSchema = z
  .object({
    provider: z.nativeEnum(AiProvider),
    model: safeText(120).min(1),
    apiKey,
    baseUrl: baseUrl.optional(),
    role: z.enum(SPECIALIST_MODEL_ROLES),
    tier: z.nativeEnum(AiModelTier),
    priority: z.number().int().min(1).max(1000),
    dailyTokenLimit: limit.optional(),
    minuteRequestLimit: limit.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.provider === 'CUSTOM' && !value.baseUrl) {
      ctx.addIssue({
        code: 'custom',
        path: ['baseUrl'],
        message: 'El proveedor CUSTOM exige baseUrl',
      });
    }
  });
export type CreateSpecialistModelInput = z.infer<
  typeof createSpecialistModelSchema
>;

export const updateSpecialistModelSchema = z
  .object({
    model: safeText(120).min(1).optional(),
    apiKey: apiKey.optional(),
    baseUrl: baseUrl.nullable().optional(),
    role: z.enum(SPECIALIST_MODEL_ROLES).optional(),
    tier: z.nativeEnum(AiModelTier).optional(),
    priority: z.number().int().min(1).max(1000).optional(),
    isActive: z.boolean().optional(),
    dailyTokenLimit: limit.nullable().optional(),
    minuteRequestLimit: limit.nullable().optional(),
  })
  .strict()
  .refine(
    (value) => Object.values(value).some((field) => field !== undefined),
    { message: 'Indica al menos un campo para modificar' },
  );
export type UpdateSpecialistModelInput = z.infer<
  typeof updateSpecialistModelSchema
>;
