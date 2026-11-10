import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ResolveController } from 'src/api/resolve/resolve.controller';

const user = { tenantId: 't1' } as never;

describe('resolución de línea por clave', () => {
  it('devuelve tenant, línea y bot', async () => {
    const connections = {
      findByKey: jest
        .fn()
        .mockResolvedValue({ id: 'l1', tenantId: 't1', botConfigId: 'b1' }),
    };
    const controller = new ResolveController(connections as never);
    await expect(controller.resolve('ventas', user)).resolves.toEqual({
      tenantId: 't1',
      lineId: 'l1',
      botId: 'b1',
    });
    expect(connections.findByKey).toHaveBeenCalledWith('ventas', 't1');
  });

  it('botId es null cuando la línea no tiene bot', async () => {
    const connections = {
      findByKey: jest
        .fn()
        .mockResolvedValue({ id: 'l1', tenantId: 't1', botConfigId: null }),
    };
    const controller = new ResolveController(connections as never);
    expect((await controller.resolve('ventas', user)).botId).toBeNull();
  });

  it('exige el parámetro line', async () => {
    const controller = new ResolveController({} as never);
    await expect(controller.resolve(undefined, user)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('propaga el 404 si la clave no existe en el tenant', async () => {
    const connections = {
      findByKey: jest.fn().mockRejectedValue(new NotFoundException()),
    };
    const controller = new ResolveController(connections as never);
    await expect(controller.resolve('x', user)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
