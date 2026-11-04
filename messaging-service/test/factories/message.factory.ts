import { MessageChannel } from '@prisma/client';

export function makeMessagePayload(overrides: Record<string, unknown> = {}) {
  return {
    recipient: {
      channel: 'EMAIL',
      address: 'test@gmail.com',
      name: 'Usuario Test',
    },
    template: {
      inline: {
        subject: 'Test: {{titulo}}',
        body: '<h1>Hola {{nombre}}</h1>',
      },
    },
    variables: {
      titulo: 'Prueba de envío',
      nombre: 'Juan',
    },
    options: {
      priority: 'normal',
    },
    ...overrides,
  };
}

export function makeWhatsAppPayload(overrides: Record<string, unknown> = {}) {
  return makeMessagePayload({
    recipient: {
      channel: 'WHATSAPP',
      address: '573001234567',
      name: 'Usuario Test',
    },
    ...overrides,
  });
}
