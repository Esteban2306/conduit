import { WhatsAppContactService } from 'src/channels/whatsapp/contacts/WhatsAppContactService';

const DAY = 24 * 60 * 60 * 1000;

function service(opts: {
  policy?: 'INBOUND_ONLY' | 'ANY';
  lookbackDays?: number;
  lastInboundAt?: Date | null;
  onWhatsApp?: boolean | null;
  checkedAt?: Date | null;
}) {
  const prisma = {
    whatsAppConnection: {
      findUnique: jest.fn().mockResolvedValue({
        campaignPolicy: opts.policy ?? 'INBOUND_ONLY',
        inboundLookbackDays: opts.lookbackDays ?? 180,
      }),
    },
    whatsAppContact: {
      findUnique: jest.fn().mockResolvedValue(
        opts.lastInboundAt === undefined && opts.onWhatsApp === undefined
          ? null
          : {
              lastInboundAt: opts.lastInboundAt ?? null,
              onWhatsApp: opts.onWhatsApp ?? null,
              checkedAt: opts.checkedAt ?? null,
            },
      ),
      upsert: jest.fn(),
    },
  };
  return { svc: new WhatsAppContactService(prisma as any), prisma };
}

describe('WhatsAppContactService.campaignGate', () => {
  it('bloquea a quien nunca escribió', async () => {
    const { svc } = service({});
    const gate = await svc.campaignGate('c1', '573001234567');
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toContain('nunca le ha escrito');
  });

  it('permite a quien escribió dentro de la ventana', async () => {
    const { svc } = service({ lastInboundAt: new Date(Date.now() - 10 * DAY) });
    await expect(svc.campaignGate('c1', '573001234567')).resolves.toEqual({
      allowed: true,
    });
  });

  it('bloquea a quien escribió hace más de la ventana', async () => {
    const { svc } = service({
      lastInboundAt: new Date(Date.now() - 200 * DAY),
    });
    const gate = await svc.campaignGate('c1', '573001234567');
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toContain('180 días');
  });

  it('con política ANY permite a cualquiera', async () => {
    const { svc } = service({ policy: 'ANY' });
    await expect(svc.campaignGate('c1', '573001234567')).resolves.toEqual({
      allowed: true,
    });
  });
});

describe('WhatsAppContactService.cachedExistence', () => {
  it('usa el dato vigente y pide consultar cuando venció', async () => {
    const fresh = service({ onWhatsApp: true, checkedAt: new Date() });
    await expect(fresh.svc.cachedExistence('c1', '57300')).resolves.toBe(true);

    const stale = service({
      onWhatsApp: false,
      checkedAt: new Date(Date.now() - 8 * DAY),
    });
    await expect(stale.svc.cachedExistence('c1', '57300')).resolves.toBeNull();
  });
});

describe('WhatsAppContactService opt-out', () => {
  function withPrisma() {
    const prisma = {
      whatsAppContact: {
        findUnique: jest.fn(),
        upsert: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    return { svc: new WhatsAppContactService(prisma as any), prisma };
  }

  it('marca y quita el opt-out de un teléfono', async () => {
    const { svc, prisma } = withPrisma();
    await svc.setOptOut('c1', '573001234567', true);
    expect(
      prisma.whatsAppContact.upsert.mock.calls[0][0].update.optedOutAt,
    ).toBeInstanceOf(Date);
    await svc.setOptOut('c1', '573001234567', false);
    expect(
      prisma.whatsAppContact.upsert.mock.calls[1][0].update.optedOutAt,
    ).toBeNull();
  });

  it('un chat identificado solo por LID se marca por su LID', async () => {
    const { svc, prisma } = withPrisma();
    await svc.setOptOut('c1', '99887766@lid', true);
    expect(prisma.whatsAppContact.updateMany).toHaveBeenCalledWith({
      where: { connectionId: 'c1', lid: '99887766' },
      data: { optedOutAt: expect.any(Date) },
    });
    expect(prisma.whatsAppContact.upsert).not.toHaveBeenCalled();
  });

  it('isOptedOut refleja la marca', async () => {
    const { svc, prisma } = withPrisma();
    prisma.whatsAppContact.findUnique.mockResolvedValueOnce({
      optedOutAt: new Date(),
    });
    expect(await svc.isOptedOut('c1', '573001234567')).toBe(true);
    prisma.whatsAppContact.findUnique.mockResolvedValueOnce({
      optedOutAt: null,
    });
    expect(await svc.isOptedOut('c1', '573001234567')).toBe(false);
    prisma.whatsAppContact.findUnique.mockResolvedValueOnce(null);
    expect(await svc.isOptedOut('c1', '573001234567')).toBe(false);
  });
});

describe('WhatsAppContactService.isOptedOutForTenant', () => {
  it('consulta solo contactos con baja de conexiones del mismo tenant', async () => {
    const findFirst = jest.fn().mockResolvedValue({ id: 'x' });
    const svc = new WhatsAppContactService({
      whatsAppContact: { findFirst },
    } as any);

    expect(await svc.isOptedOutForTenant('t1', '573001234567')).toBe(true);
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        address: '573001234567',
        optedOutAt: { not: null },
        connection: { tenantId: 't1' },
      },
      select: { id: true },
    });
  });

  it('sin baja registrada en ninguna línea del tenant devuelve false', async () => {
    const svc = new WhatsAppContactService({
      whatsAppContact: { findFirst: jest.fn().mockResolvedValue(null) },
    } as any);
    expect(await svc.isOptedOutForTenant('t1', '573001234567')).toBe(false);
  });
});
