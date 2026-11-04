import axios from 'axios';
import { Job, UnrecoverableError } from 'bullmq';
import { WebhookDeliveryWorker } from 'src/webhooks/WebhookDeliveryWorker';
import type { WebhookDeliveryJob } from 'src/webhooks/WebhookDispatcher';

const mockedPost = jest.spyOn(axios, 'post');

const respond = (response: {
  status: number;
  data: unknown;
  headers: Record<string, string>;
}) => mockedPost.mockResolvedValue(response);

describe('WebhookDeliveryWorker', () => {
  const update = jest.fn<
    Promise<void>,
    [{ data: { deliveredAt: Date | null } }]
  >();
  update.mockResolvedValue(undefined);
  const prisma = {
    webhookDelivery: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'entrega-1',
        eventType: 'message.sent',
        deliveredAt: null,
        payload: { event: 'message.sent' },
        webhook: {
          url: 'https://receptor.test/webhook',
          secret: 'secreto',
          isActive: true,
        },
      }),
      update,
    },
  };
  const worker = new WebhookDeliveryWorker({} as never, prisma as never);
  const deliver = (job: Job<WebhookDeliveryJob>) =>
    (
      worker as unknown as {
        deliver: (j: Job<WebhookDeliveryJob>) => Promise<void>;
      }
    ).deliver(job);
  const job = { data: { deliveryId: 'entrega-1' } } as Job<WebhookDeliveryJob>;

  beforeEach(() => {
    mockedPost.mockReset();
    update.mockClear();
  });

  it('entrega y registra la respuesta cuando el receptor responde 2xx', async () => {
    respond({
      status: 200,
      data: { ok: true },
      headers: {},
    });
    await expect(deliver(job)).resolves.toBeUndefined();
    expect(update.mock.calls[0][0].data.deliveredAt).toBeInstanceOf(Date);
  });

  it('un 404 del receptor es un rechazo permanente y no se reintenta', async () => {
    respond({
      status: 404,
      data: 'no existe',
      headers: {},
    });
    await expect(deliver(job)).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('un 404 del túnel caído (ngrok) se reintenta en lugar de perder el evento', async () => {
    respond({
      status: 404,
      data: '<html>endpoint offline</html>',
      headers: { 'ngrok-error-code': 'ERR_NGROK_3200' },
    });
    const error = await deliver(job).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(UnrecoverableError);
    expect(update.mock.calls[0][0].data.deliveredAt).toBeNull();
  });

  it('un 5xx se reintenta', async () => {
    respond({ status: 503, data: 'caído', headers: {} });
    const error = await deliver(job).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(UnrecoverableError);
  });
});
