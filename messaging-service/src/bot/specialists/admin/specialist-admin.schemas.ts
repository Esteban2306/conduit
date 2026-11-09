import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import {
  capabilitySchema,
  contextSourcesDocumentSchema,
  rulesDocumentSchema,
  safeText,
  specialistKeySchema,
  MAX_PROMPT_LENGTH,
} from '../contracts';

const changeNote = safeText(200).optional();
const expectedVersion = z.number().int().min(1).optional();

export const createSpecialistSchema = z
  .object({
    key: specialistKeySchema.optional(),
    name: safeText(120).min(1),
    capability: capabilitySchema,
    promptTemplate: z.string().min(1).max(MAX_PROMPT_LENGTH),
    rules: rulesDocumentSchema.optional(),
    contextSources: contextSourcesDocumentSchema.optional(),
    changeNote,
  })
  .strict();
export type CreateSpecialistInput = z.infer<typeof createSpecialistSchema>;

export const SPECIALIST_STATUSES = ['ACTIVE', 'INACTIVE'] as const;

export const updateSpecialistSchema = z
  .object({
    name: safeText(120).min(1).optional(),
    promptTemplate: z.string().min(1).max(MAX_PROMPT_LENGTH).optional(),
    rules: rulesDocumentSchema.optional(),
    contextSources: contextSourcesDocumentSchema.optional(),
    status: z.enum(SPECIALIST_STATUSES).optional(),
    changeNote,
    expectedVersion,
  })
  .strict()
  .refine(
    (value) =>
      ['name', 'promptTemplate', 'rules', 'contextSources', 'status'].some(
        (field) => (value as Record<string, unknown>)[field] !== undefined,
      ),
    { message: 'Indica al menos un campo para modificar' },
  );
export type UpdateSpecialistInput = z.infer<typeof updateSpecialistSchema>;

export const restoreSpecialistSchema = z
  .object({ changeNote, expectedVersion })
  .strict();
export type RestoreSpecialistInput = z.infer<typeof restoreSpecialistSchema>;

export const listSpecialistsSchema = z
  .object({
    status: z.enum(SPECIALIST_STATUSES).optional(),
    capability: capabilitySchema.optional(),
    includeArchived: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true')
      .optional(),
  })
  .strict();
export type ListSpecialistsQuery = z.infer<typeof listSpecialistsSchema>;

export function parseOrThrow<T extends z.ZodType>(
  schema: T,
  data: unknown,
): z.infer<T> {
  const parsed = schema.safeParse(data ?? {});
  if (parsed.success) return parsed.data;
  throw new BadRequestException({
    message: 'Datos inválidos',
    issues: parsed.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message:
        issue.code === 'unrecognized_keys'
          ? `Campos no permitidos o inmutables: ${issue.keys.join(', ')}`
          : issue.message,
    })),
  });
}
