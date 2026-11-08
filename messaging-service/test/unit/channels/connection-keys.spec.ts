import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { WhatsAppConnectionService } from 'src/channels/whatsapp/WhatsAppConnection.service';

const p2002 = () =>
  new Prisma.PrismaClientKnownRequestError('dup', {
    code: 'P2002',
    clientVersion: 'test',
  });

function build(existingKeys: string[] = []) {
  const created: Array<Record<string, unknown>> = [];
  const update = jest.fn();
  const tx = {
    botConfig: { findFirst: jest.fn().mockResolvedValue({ id: 'bot-1' }) },
    whatsAppConnection: {
      create: jest.fn(({ data }) => {
        created.push(data);
        return Promise.resolve({ id: 'c1', ...data });
      }),
    },
  };
  const prisma = {
    whatsAppConnection: {
      count: jest.fn(({ where }) =>
        Promise.resolve(existingKeys.includes(where.key) ? 1 : 0),
      ),
      findFirst: jest.fn(),
      update,
    },
    $transaction: jest.fn((fn) => fn(tx)),
  };
  return {
    service: new WhatsAppConnectionService(prisma as never),
    prisma,
    created,
    update,
  };
}

describe('claves de conexión', () => {
  it('genera la clave desde el nombre cuando no se envía', async () => {
    const { service, created } = build();
    await service.create('t1', { name: 'Línea Ventas' });
    expect(created[0].key).toBe('linea-ventas');
  });

  it('agrega sufijo si la clave generada ya existe', async () => {
    const { service, created } = build(['ventas']);
    await service.create('t1', { name: 'Ventas' });
    expect(created[0].key).toBe('ventas-2');
  });

  it('rechaza una clave explícita ya usada en el tenant', async () => {
    const { service } = build(['ventas']);
    await expect(
      service.create('t1', { name: 'Otra', key: 'ventas' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('busca por clave filtrando siempre por tenant', async () => {
    const { service, prisma } = build();
    prisma.whatsAppConnection.findFirst.mockResolvedValue(null);
    await expect(service.findByKey('ventas', 't1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.whatsAppConnection.findFirst).toHaveBeenCalledWith({
      where: { tenantId: 't1', key: 'ventas' },
    });
  });

  it('si el número ya está en otra conexión, marca conectada sin guardarlo', async () => {
    const { service, update } = build();
    update.mockRejectedValueOnce(p2002()).mockResolvedValueOnce({ id: 'c1' });
    await service.markConnected('c1', '573000000001');
    expect(update).toHaveBeenCalledTimes(2);
    expect(update.mock.calls[1][0].data).not.toHaveProperty('phoneNumber');
  });
});
