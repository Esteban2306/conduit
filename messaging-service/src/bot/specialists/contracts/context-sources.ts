import { z } from 'zod';
import { groundingKeySchema, safeText } from './keys';

export const CONTEXT_SOURCES_VERSION = 1;
export const MAX_CONTEXT_SOURCES = 10;
export const MAX_SOURCE_AGE_SECONDS = 3600;

export const CONTEXT_SOURCE_KINDS = ['TOOL', 'EXTERNAL_MAPPING'] as const;

export const contextSourceSchema = z
  .object({
    key: groundingKeySchema,
    kind: z.enum(CONTEXT_SOURCE_KINDS),
    name: safeText(120).min(1),
    valuePath: z
      .string()
      .max(120)
      .regex(
        /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*$/,
        'valuePath debe ser una ruta con puntos, por ejemplo data.anticipo.monto',
      ),
    maxAgeSeconds: z
      .number()
      .int()
      .min(0)
      .max(MAX_SOURCE_AGE_SECONDS)
      .default(60),
    required: z.boolean().default(false),
  })
  .strict();
export type ContextSource = z.infer<typeof contextSourceSchema>;

export const contextSourcesDocumentSchema = z
  .object({
    version: z.literal(CONTEXT_SOURCES_VERSION),
    sources: z.array(contextSourceSchema).max(MAX_CONTEXT_SOURCES),
  })
  .strict()
  .superRefine((doc, ctx) => {
    const seen = new Set<string>();
    doc.sources.forEach((source, index) => {
      if (seen.has(source.key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['sources', index, 'key'],
          message: `La clave de contexto "${source.key}" está repetida`,
        });
      }
      seen.add(source.key);
    });
  });
export type ContextSourcesDocument = z.infer<
  typeof contextSourcesDocumentSchema
>;

export const EMPTY_CONTEXT_SOURCES: ContextSourcesDocument = {
  version: CONTEXT_SOURCES_VERSION,
  sources: [],
};
