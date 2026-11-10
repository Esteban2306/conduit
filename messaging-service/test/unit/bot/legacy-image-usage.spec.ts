import { BadRequestException } from '@nestjs/common';
import { LegacyImageUsageController } from 'src/bot/ai/LegacyImageUsage.controller';
import { LegacyImageUsageService } from 'src/bot/ai/LegacyImageUsage.service';

describe('LegacyImageUsageService.record', () => {
  const build = (execute: jest.Mock) => {
    const service = new LegacyImageUsageService({
      $executeRaw: execute,
    } as never);
    const warn = jest.fn();
    (service as unknown as { logger: object }).logger = { warn };
    return { service, warn };
  };

  it('escribe una fila y deja una línea de registro con bot y tenant', () => {
    const execute = jest.fn().mockResolvedValue(1);
    const { service, warn } = build(execute);
    service.record('tenant-1', 'bot-1');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('bot-1');
    expect(warn.mock.calls[0][0]).toContain('tenant-1');
  });

  it.each([
    ['rechaza', () => jest.fn().mockRejectedValue(new Error('db caída'))],
    [
      'lanza',
      () =>
        jest.fn(() => {
          throw new Error('boom');
        }),
    ],
  ])(
    'si la base %s, no lanza ni deja una promesa sin atrapar',
    async (_n, make) => {
      const { service } = build(make());
      expect(() => service.record('t', 'b')).not.toThrow();
      await new Promise((resolve) => setImmediate(resolve));
    },
  );
});

describe('LegacyImageUsageController', () => {
  const build = () => {
    const usage = { summary: jest.fn().mockResolvedValue({ ok: true }) };
    return {
      usage,
      controller: new LegacyImageUsageController(usage as never),
    };
  };
  const user = { tenantId: 't1' } as never;

  it('sin days usa la ventana por defecto del servicio', () => {
    const { controller, usage } = build();
    void controller.summary(user);
    expect(usage.summary).toHaveBeenCalledWith('t1', undefined);
  });

  it('pasa days válidos', () => {
    const { controller, usage } = build();
    void controller.summary(user, '30');
    expect(usage.summary).toHaveBeenCalledWith('t1', 30);
  });

  it.each(['abc', '0', '-3', '1.5', '91', '', 'NaN'])(
    'rechaza days=%j con 400 y no consulta',
    (days) => {
      const { controller, usage } = build();
      expect(() => controller.summary(user, days)).toThrow(BadRequestException);
      expect(usage.summary).not.toHaveBeenCalled();
    },
  );
});
