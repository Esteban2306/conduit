import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  MutedContactService,
  normalizeMutedAddress,
} from 'src/bot/mute/MutedContact.service';
import { MutedContactsController } from 'src/bot/mute/MutedContacts.controller';

function build(
  muted: Array<{ botConfigId: string; address: string }> = [],
  contacts: Array<{
    connectionId: string;
    address: string;
    lid: string | null;
  }> = [],
) {
  const rows = [...muted];
  const prisma = {
    whatsAppContact: {
      findFirst: jest.fn(
        ({
          where,
        }: {
          where: { connectionId?: string; lid?: string; address?: string };
        }) =>
          Promise.resolve(
            contacts.find(
              (c) =>
                (!where.connectionId ||
                  c.connectionId === where.connectionId) &&
                (where.lid ? c.lid === where.lid : c.address === where.address),
            ) ?? null,
          ),
      ),
    },
    mutedContact: {
      findFirst: jest.fn(
        ({
          where,
        }: {
          where: { botConfigId: string; address: { in: string[] } };
        }) =>
          Promise.resolve(
            rows.find(
              (r) =>
                r.botConfigId === where.botConfigId &&
                where.address.in.includes(r.address),
            ) ?? null,
          ),
      ),
      findMany: jest.fn(() => Promise.resolve(rows)),
      upsert: jest.fn(
        ({
          create,
        }: {
          create: {
            botConfigId: string;
            address: string;
            reason: string | null;
          };
        }) => {
          rows.push(create);
          return Promise.resolve(create);
        },
      ),
      deleteMany: jest.fn(
        ({ where }: { where: { botConfigId: string; address: string } }) => {
          const index = rows.findIndex(
            (r) =>
              r.botConfigId === where.botConfigId &&
              r.address === where.address,
          );
          if (index >= 0) rows.splice(index, 1);
          return Promise.resolve({ count: index >= 0 ? 1 : 0 });
        },
      ),
    },
  };
  return { service: new MutedContactService(prisma as never), prisma, rows };
}

describe('normalizeMutedAddress', () => {
  it.each([
    ['+57 300 123 4567', '573001234567'],
    ['573001234567', '573001234567'],
    ['123456789012345@lid', '123456789012345@lid'],
  ])('%s → %s', (raw, expected) => {
    expect(normalizeMutedAddress(raw)).toBe(expected);
  });

  it.each(['12345', 'abc', '', '12@lid'])('%s no es válido', (raw) => {
    expect(normalizeMutedAddress(raw)).toBeNull();
  });
});

describe('MutedContactService.isMuted', () => {
  it('un número silenciado está silenciado solo en su bot', async () => {
    const { service } = build([
      { botConfigId: 'bot', address: '573001234567' },
    ]);
    expect(await service.isMuted('bot', '573001234567')).toBe(true);
    expect(await service.isMuted('otro-bot', '573001234567')).toBe(false);
    expect(await service.isMuted('bot', '573009999999')).toBe(false);
  });

  it('si escribe por LID se reconoce el número silenciado', async () => {
    const { service } = build(
      [{ botConfigId: 'bot', address: '573001234567' }],
      [{ connectionId: 'c1', address: '573001234567', lid: '998877665544' }],
    );
    expect(await service.isMuted('bot', '998877665544@lid', 'c1')).toBe(true);
  });

  it('si se silenció por LID y luego escribe con su número, sigue silenciado', async () => {
    const { service } = build(
      [{ botConfigId: 'bot', address: '998877665544@lid' }],
      [{ connectionId: 'c1', address: '573001234567', lid: '998877665544' }],
    );
    expect(await service.isMuted('bot', '573001234567', 'c1')).toBe(true);
  });
});

describe('MutedContactsController', () => {
  const user = { tenantId: 't1' } as never;
  const bots = { findOne: jest.fn(() => Promise.resolve({ id: 'bot' })) };

  it('silencia un número con su motivo y lo normaliza', async () => {
    const { service, prisma } = build();
    const controller = new MutedContactsController(bots as never, service);
    await controller.mute(
      'bot',
      encodeURIComponent('+57 300 123 4567'),
      { reason: ' Bot de otra empresa ' },
      user,
    );
    expect(prisma.mutedContact.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: {
          tenantId: 't1',
          botConfigId: 'bot',
          address: '573001234567',
          reason: 'Bot de otra empresa',
        },
      }),
    );
    expect(bots.findOne).toHaveBeenCalledWith('bot', 't1');
  });

  it('rechaza una dirección inválida', async () => {
    const { service } = build();
    const controller = new MutedContactsController(bots as never, service);
    await expect(
      controller.mute('bot', '12345', {}, user),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('quitar el silencio de un contacto que no estaba silenciado responde 404', async () => {
    const { service } = build();
    const controller = new MutedContactsController(bots as never, service);
    await expect(
      controller.unmute('bot', '573001234567', user),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('quitar el silencio lo saca de la lista', async () => {
    const { service, rows } = build([
      { botConfigId: 'bot', address: '573001234567' },
    ]);
    const controller = new MutedContactsController(bots as never, service);
    expect(await controller.unmute('bot', '573001234567', user)).toEqual({
      address: '573001234567',
      muted: false,
    });
    expect(rows).toHaveLength(0);
  });
});
