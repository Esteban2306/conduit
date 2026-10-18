import { ConfigService } from '@nestjs/config';
import { GmailResendPlugin } from 'src/channels/email/resend/GmailResendPlugin';

const send = jest.fn();
jest.mock('resend', () => ({
  Resend: jest.fn().mockImplementation(() => ({ emails: { send } })),
}));

describe('GmailResendPlugin', () => {
  const config = {
    get: (key: string) =>
      ({
        'resend.apiKey': 're_prueba',
        'resend.fromName': 'Leonice Spa',
        'resend.fromEmail': 'notificaciones@estebancl.dev',
      })[key],
  } as unknown as ConfigService;
  const plugin = new GmailResendPlugin(config);
  const payload = {
    to: 'equipo@estebancl.dev',
    subject: 'Aviso',
    content: '<p>Hola</p>',
  };

  beforeEach(() => send.mockReset());

  it('marca enviado solo cuando Resend devuelve el id del correo', async () => {
    send.mockResolvedValue({ data: { id: 'correo-1' }, error: null });
    await expect(plugin.send(payload as never)).resolves.toMatchObject({
      success: true,
      provider: 'resend',
      providerMessageId: 'correo-1',
    });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'Leonice Spa <notificaciones@estebancl.dev>',
      }),
    );
  });

  it('un rechazo de la API (dominio no verificado) es un fallo permanente, no un envío', async () => {
    send.mockResolvedValue({
      data: null,
      error: {
        name: 'validation_error',
        message: 'domain is not verified',
        statusCode: 403,
      },
    });
    await expect(plugin.send(payload as never)).resolves.toMatchObject({
      success: false,
      retryable: false,
      errorCode: 'validation_error',
    });
  });

  it('un límite de envío o una caída de Resend se reintenta', async () => {
    send.mockResolvedValue({
      data: null,
      error: {
        name: 'rate_limit_exceeded',
        message: 'too many',
        statusCode: 429,
      },
    });
    await expect(plugin.send(payload as never)).resolves.toMatchObject({
      success: false,
      retryable: true,
    });
  });

  it('una excepción de red se reintenta', async () => {
    send.mockRejectedValue(new Error('ECONNRESET'));
    await expect(plugin.send(payload as never)).resolves.toMatchObject({
      success: false,
      retryable: true,
    });
  });
});
