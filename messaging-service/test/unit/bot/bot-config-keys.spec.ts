import { ConflictException, NotFoundException } from '@nestjs/common';
import { BotConfigService } from 'src/bot/config/BotConfigService';

function build(existingKeys: string[] = []) {
  const created: Array<Record<string, unknown>> = [];
  const prisma = {
    botConfig: {
      count: jest.fn(({ where }: { where: { key: string } }) =>
        Promise.resolve(existingKeys.includes(where.key) ? 1 : 0),
      ),
      create: jest.fn(({ data }) => {
        created.push(data);
        return Promise.resolve({ id: 'b1', ...data });
      }),
      findFirst: jest.fn<
        Promise<unknown>,
        [{ where: Record<string, unknown> }]
      >(),
    },
  };
  const service = new BotConfigService(
    prisma as never,
    {} as never,
    {} as never,
  );
  return { service, prisma, created };
}

const dto = { name: 'Bot Reservas Ñandú', systemPrompt: 'hola' };

describe('claves de bot', () => {
  it('genera la clave desde el nombre', async () => {
    const { service, created } = build();
    await service.create('t1', dto);
    expect(created[0].key).toBe('bot-reservas-nandu');
  });

  it('agrega sufijo si ya existe en el tenant', async () => {
    const { service, created } = build(['bot-reservas-nandu']);
    await service.create('t1', dto);
    expect(created[0].key).toBe('bot-reservas-nandu-2');
  });

  it('rechaza una clave explícita repetida', async () => {
    const { service } = build(['bot-a']);
    await expect(
      service.create('t1', { ...dto, key: 'bot-a' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('busca por clave solo dentro del tenant', async () => {
    const { service, prisma } = build();
    prisma.botConfig.findFirst.mockResolvedValue(null);
    await expect(service.findByKey('x', 't1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.botConfig.findFirst.mock.calls[0][0].where).toEqual({
      tenantId: 't1',
      key: 'x',
    });
  });
});
