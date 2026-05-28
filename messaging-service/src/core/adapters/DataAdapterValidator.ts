import { z } from 'zod';
import { MessagePayload } from './IDataAdapter';

const RecipientSchema = z.object({
  channel: z.enum(['EMAIL', 'SMTP', 'WHATSAPP']),
  address: z.string().min(1, 'El destinatario no puede estar activo'),
  name: z.string().optional(),
});

const InlineTemplateSchema = z.object({
  subject: z.string().optional(),
  body: z.string().min(1, 'el body de la plantilla no puede estar vacio.'),
});

const TemplateSchema = z
  .object({
    id: z.string().uuid('el template id debe ser un UUID válido').optional(),
    inline: InlineTemplateSchema.optional(),
  })
  .refine((t) => t.id || t.inline, {
    message:
      'Debes proveer template.id o template.inline, no pueden estar ambos vacios.',
  });

export const MessagePayloadSchema = z.object({
  recipient: RecipientSchema,
  template: TemplateSchema,
  variables: z.record(z.string(), z.unknown()).default({}),
  options: z
    .object({
      scheduledAt: z
        .string()
        .datetime({ message: 'scheduledAt debe ser ISO 8601' })
        .optional(),
      priority: z.enum(['low', 'normal', 'high']).default('normal'),
      webhookUrl: z
        .string()
        .url('webhookUrl debe ser una URL valida')
        .optional(),
    })
    .optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

export class DataAdapterValidator {
  static validate(raw: unknown): MessagePayload {
    const result = MessagePayloadSchema.safeParse(raw);
    if (!result.success) {
      const errors = result.error.issues.map((e) => ({
        field: e.path.join('.'),
        message: e.message,
      }));
      throw new DataAdapterValidationError(errors);
    }
    return result.data;
  }
}

export class DataAdapterValidationError extends Error {
  constructor(public readonly errors: { field: string; message: string }[]) {
    super('payload invalido');
    this.name = 'DataAdapterValidationError';
  }
}
