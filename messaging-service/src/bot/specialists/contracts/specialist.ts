import { z } from 'zod';
import { contextSourcesDocumentSchema } from './context-sources';
import { capabilitySchema, safeText, specialistKeySchema } from './keys';
import { declaredOutputSchemaSchema } from './output-schema';
import { rulesDocumentSchema } from './rules';

export const MAX_PROMPT_LENGTH = 8000;

export const specialistInputSchema = z
  .object({
    key: specialistKeySchema.optional(),
    name: safeText(120).min(1),
    capability: capabilitySchema,
    promptTemplate: z.string().min(1).max(MAX_PROMPT_LENGTH),
    outputSchema: declaredOutputSchemaSchema,
    rules: rulesDocumentSchema.optional(),
    contextSources: contextSourcesDocumentSchema.optional(),
  })
  .strict();
export type SpecialistInput = z.infer<typeof specialistInputSchema>;
