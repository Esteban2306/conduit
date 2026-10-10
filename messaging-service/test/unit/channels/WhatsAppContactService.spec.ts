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
