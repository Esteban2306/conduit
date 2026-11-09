import { z } from 'zod';
import { safeText } from './keys';

export const OUTPUT_SCHEMA_VERSION = 1;
export const MAX_VARIABLES = 12;
export const MAX_VARIABLE_NAME = 20;
export const MAX_ENUM_VALUES = 20;
export const MAX_STRING_LENGTH = 200;
export const MAX_UNIQUE_BY = 4;

export const VARIABLE_TYPES = [
  'number',
  'string',
  'boolean',
  'date',
  'enum',
] as const;
export type VariableType = (typeof VARIABLE_TYPES)[number];

const RESERVED_NAMES = new Set([
  'constructor',
  'prototype',
  'version',
  'confidence',
  'legibility',
  'variables',
]);

export const variableNameSchema = z
  .string()
  .regex(
    new RegExp(`^[a-z][a-z0-9_]{0,${MAX_VARIABLE_NAME - 1}}$`),
    `El nombre debe empezar por minúscula y usar solo minúsculas, números y guion bajo (máx. ${MAX_VARIABLE_NAME}).`,
  )
  .refine((name) => !RESERVED_NAMES.has(name), {
    message: 'Ese nombre está reservado.',
  });

const common = {
  name: variableNameSchema,
  description: safeText(200).min(1),
  label: safeText(40).min(1).optional(),
};

const numberVariable = z
  .object({
    ...common,
    type: z.literal('number'),
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
    tolerance: z.number().finite().min(0).max(1_000_000).optional(),
  })
  .strict();

const stringVariable = z
  .object({
    ...common,
    type: z.literal('string'),
    maxLength: z.number().int().min(1).max(MAX_STRING_LENGTH).optional(),
    identityMinLength: z
      .number()
      .int()
      .min(1)
      .max(MAX_STRING_LENGTH)
      .optional(),
    exposeToBot: z.boolean().optional(),
  })
  .strict();

const booleanVariable = z
  .object({ ...common, type: z.literal('boolean') })
  .strict();

const dateVariable = z.object({ ...common, type: z.literal('date') }).strict();

const enumVariable = z
  .object({
    ...common,
    type: z.literal('enum'),
    values: z.array(safeText(40).min(1)).min(1).max(MAX_ENUM_VALUES),
  })
  .strict();

export const variableSchema = z
  .discriminatedUnion('type', [
    numberVariable,
    stringVariable,
    booleanVariable,
    dateVariable,
    enumVariable,
  ])
  .superRefine((variable, ctx) => {
    if (variable.type === 'number') {
      if (
        variable.min !== undefined &&
        variable.max !== undefined &&
        variable.min > variable.max
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['min'],
          message: 'min no puede ser mayor que max',
        });
      }
    }
    if (variable.type === 'enum') {
      if (new Set(variable.values).size !== variable.values.length) {
        ctx.addIssue({
          code: 'custom',
          path: ['values'],
          message: 'Los valores no pueden repetirse',
        });
      }
    }
  });
export type Variable = z.infer<typeof variableSchema>;

function checkDocument(
  document: { variables: Variable[]; uniqueBy: string[] },
  ctx: z.RefinementCtx,
): void {
  const names = new Set<string>();
  for (const [index, variable] of document.variables.entries()) {
    if (names.has(variable.name)) {
      ctx.addIssue({
        code: 'custom',
        path: ['variables', index, 'name'],
        message: `La variable ${variable.name} está repetida`,
      });
    }
    names.add(variable.name);
  }
  const seen = new Set<string>();
  for (const [index, name] of document.uniqueBy.entries()) {
    if (!names.has(name)) {
      ctx.addIssue({
        code: 'custom',
        path: ['uniqueBy', index],
        message: `uniqueBy cita la variable ${name}, que no está declarada`,
      });
    }
    if (seen.has(name)) {
      ctx.addIssue({
        code: 'custom',
        path: ['uniqueBy', index],
        message: `uniqueBy repite ${name}`,
      });
    }
    seen.add(name);
  }
}

const documentShape = {
  version: z.literal(OUTPUT_SCHEMA_VERSION),
  uniqueBy: z.array(variableNameSchema).max(MAX_UNIQUE_BY).default([]),
};

export const outputSchemaDocumentSchema = z
  .object({
    ...documentShape,
    variables: z.array(variableSchema).max(MAX_VARIABLES),
  })
  .strict()
  .superRefine(checkDocument);
export type OutputSchemaDocument = z.infer<typeof outputSchemaDocumentSchema>;

export const declaredOutputSchemaSchema = z
  .object({
    ...documentShape,
    variables: z.array(variableSchema).min(1).max(MAX_VARIABLES),
  })
  .strict()
  .superRefine(checkDocument);

export const EMPTY_OUTPUT_SCHEMA: OutputSchemaDocument = {
  version: OUTPUT_SCHEMA_VERSION,
  variables: [],
  uniqueBy: [],
};

export function findVariable(
  schema: OutputSchemaDocument,
  name: string,
): Variable | undefined {
  return schema.variables.find((variable) => variable.name === name);
}
