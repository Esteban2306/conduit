import { PrismaClient, WhatsAppConnectionStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import { LineAdoptionService } from 'src/channels/whatsapp/LineAdoption.service';

jest.mock('@whiskeysockets/baileys', () => ({
  __esModule: true,
  default: jest.fn(),
  downloadMediaMessage: jest.fn(),
  DisconnectReason: { loggedOut: 401 },
  fetchLatestBaileysVersion: jest.fn(),
  makeCacheableSignalKeyStore: jest.fn(),
  BufferJSON: {},
  initAuthCreds: jest.fn(),
  proto: {},
}));

const url = process.env.TEST_DATABASE_URL ?? '';
const isolated = /\/[^/?]*test[^/?]*(\?|$)/i.test(url);
const suite = isolated ? describe : describe.skip;

suite('adopción de líneas contra una base aislada', () => {
  const prisma = new PrismaClient({ datasourceUrl: url });
  const NUMBER = '573001112233';
  const sessionManager = {
    stop: jest.fn().mockResolvedValue(undefined),
    start: jest.fn().mockResolvedValue(undefined),
  };
  const service = new LineAdoptionService(
    prisma as never,
    sessionManager as never,
  );
  const created: string[] = [];

  afterAll(async () => {
    for (const tenantId of created) {
      await prisma.whatsAppConnectionAudit.deleteMany({ where: { tenantId } });
      await prisma.botMessage.deleteMany({
        where: { conversation: { tenantId } },
      });
      await prisma.outboundReply.deleteMany({ where: { tenantId } });
      await prisma.message.deleteMany({ where: { tenantId } });
      await prisma.conversation.deleteMany({ where: { tenantId } });
      await prisma.botEscalationContact.deleteMany({
        where: { botConfig: { tenantId } },
      });
      await prisma.whatsAppConnection.deleteMany({ where: { tenantId } });
      await prisma.botConfig.deleteMany({ where: { tenantId } });
      await prisma.tenant.delete({ where: { id: tenantId } });
    }
    await prisma.$disconnect();
  });

  beforeEach(() => jest.clearAllMocks());

  async function seed(
    opts: { retireNumber?: string | null; retireSessions?: number } = {},
  ) {
    const tenantId = randomUUID();
    created.push(tenantId);
    await prisma.tenant.create({
      data: { id: tenantId, name: 't', slug: tenantId },
    });
    const bot = await prisma.botConfig.create({
      data: { tenantId, name: 'bot', key: 'bot-ventas', systemPrompt: 'x' },
    });
    const keep = await prisma.whatsAppConnection.create({
      data: {
        tenantId,
        key: 'linea-ventas',
        name: 'Ventas',
        phoneNumber: NUMBER,
        botConfigId: bot.id,
        status: WhatsAppConnectionStatus.ERROR,
        riskLevel: 3,
      },
    });
    const retire = await prisma.whatsAppConnection.create({
      data: {
        tenantId,
        key: 'linea-nueva',
        name: 'Nueva',
        phoneNumber: opts.retireNumber === undefined ? null : opts.retireNumber,
        status: WhatsAppConnectionStatus.CONNECTED,
      },
    });
    for (let i = 0; i < (opts.retireSessions ?? 2); i++) {
      await prisma.whatsAppSession.create({
        data: {
          connectionId: retire.id,
          type: 'creds',
          key: `k${i}`,
          data: { n: i },
        },
      });
    }
    await prisma.whatsAppSession.create({
      data: { connectionId: keep.id, type: 'creds', key: 'old', data: {} },
    });
    return { tenantId, bot, keep, retire };
  }

  it('conserva el id viejo, mueve credenciales y no pierde ninguna baja', async () => {
    const { tenantId, keep, retire } = await seed();
    const d = (days: number) => new Date(Date.now() - days * 86_400_000);
    await prisma.whatsAppContact.createMany({
      data: [
        { connectionId: keep.id, address: 'A', lastInboundAt: d(5) },
        { connectionId: keep.id, address: 'B', optedOutAt: d(10) },
        { connectionId: keep.id, address: 'C', optedOutAt: d(20) },
        { connectionId: retire.id, address: 'A', optedOutAt: d(1) },
        { connectionId: retire.id, address: 'B', lastInboundAt: d(2) },
        { connectionId: retire.id, address: 'C', optedOutAt: d(3) },
        { connectionId: retire.id, address: 'D', optedOutAt: d(4) },
        { connectionId: retire.id, address: 'E', lastInboundAt: d(1) },
      ],
    });

    const result = await service.adopt(tenantId, keep.id, retire.id, 'user-1');

    expect(result.counts.contacts).toEqual({ before: 5, after: 5 });
    expect(result.counts.optOuts).toEqual({ before: 4, after: 4 });

    const contacts = await prisma.whatsAppContact.findMany({
      where: { connectionId: keep.id },
    });
    const byAddress = Object.fromEntries(contacts.map((c) => [c.address, c]));
    expect(Object.keys(byAddress).sort()).toEqual(['A', 'B', 'C', 'D', 'E']);
    for (const address of ['A', 'B', 'C', 'D']) {
      expect(byAddress[address].optedOutAt).not.toBeNull();
    }
    expect(byAddress.E.optedOutAt).toBeNull();
    expect(byAddress.C.optedOutAt?.getTime()).toBeLessThan(d(2).getTime());
    expect(byAddress.B.lastInboundAt).not.toBeNull();

    expect(
      await prisma.whatsAppConnection.findUnique({ where: { id: retire.id } }),
    ).toBeNull();
    const kept = await prisma.whatsAppConnection.findUniqueOrThrow({
      where: { id: keep.id },
    });
    expect(kept.key).toBe('linea-ventas');
    expect(kept.botConfigId).not.toBeNull();
    expect(kept.riskLevel).toBe(3);
    expect(kept.phoneNumber).toBe(NUMBER);
    expect(kept.status).toBe(WhatsAppConnectionStatus.CONNECTING);

    const sessions = await prisma.whatsAppSession.findMany({
      where: { connectionId: keep.id },
    });
    expect(sessions.map((s) => s.key).sort()).toEqual(['k0', 'k1']);

    const audit = await prisma.whatsAppConnectionAudit.findMany({
      where: { tenantId },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: 'ADOPT',
      keptConnectionId: keep.id,
      retiredConnectionId: retire.id,
      retiredKey: 'linea-nueva',
      actor: 'user-1',
    });
    expect(sessionManager.start).toHaveBeenCalledWith(keep.id);
    expect(result.started).toBe(true);
  });

  it('reapunta las referencias sueltas a la conexión que se conserva', async () => {
    const { tenantId, bot, keep, retire } = await seed();
    const conversation = await prisma.conversation.create({
      data: {
        tenantId,
        botConfigId: bot.id,
        phoneNumber: 'A',
        lastConnectionId: retire.id,
      },
    });
    await prisma.botMessage.create({
      data: {
        conversationId: conversation.id,
        connectionId: retire.id,
        direction: 'INBOUND',
        content: 'hola',
      },
    });
    await prisma.botEscalationContact.create({
      data: {
        botConfigId: bot.id,
        label: 'x',
        phoneNumber: '1',
        connectionId: retire.id,
      },
    });
    await prisma.outboundReply.create({
      data: {
        tenantId,
        connectionId: retire.id,
        phoneNumber: 'A',
        groupId: 'g',
        seq: 0,
        bubbleCount: 1,
        content: 'r',
        idempotencyKey: randomUUID(),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    const { counts } = await service.adopt(tenantId, keep.id, retire.id);

    expect(counts.repointed).toMatchObject({
      botMessages: 1,
      conversations: 1,
      escalationContacts: 1,
      outboundReplies: 1,
    });
    expect(
      (
        await prisma.conversation.findUniqueOrThrow({
          where: { id: conversation.id },
        })
      ).lastConnectionId,
    ).toBe(keep.id);
    expect(
      await prisma.botMessage.count({ where: { connectionId: retire.id } }),
    ).toBe(0);
    expect(
      await prisma.outboundReply.count({ where: { connectionId: keep.id } }),
    ).toBe(1);
  });

  it('rechaza sin tocar nada si la conexión a retirar no tiene credenciales', async () => {
    const { tenantId, keep, retire } = await seed({ retireSessions: 0 });
    await prisma.whatsAppContact.create({
      data: { connectionId: retire.id, address: 'A', optedOutAt: new Date() },
    });

    await expect(service.adopt(tenantId, keep.id, retire.id)).rejects.toThrow(
      /credenciales/,
    );

    expect(await prisma.whatsAppConnection.count({ where: { tenantId } })).toBe(
      2,
    );
    expect(
      await prisma.whatsAppContact.count({
        where: { connectionId: retire.id },
      }),
    ).toBe(1);
    expect(
      await prisma.whatsAppSession.count({ where: { connectionId: keep.id } }),
    ).toBe(1);
    expect(
      await prisma.whatsAppConnectionAudit.count({ where: { tenantId } }),
    ).toBe(0);
    expect(sessionManager.start).toHaveBeenCalledWith(retire.id);
  });

  it('rechaza números distintos y conexiones de otro tenant', async () => {
    const a = await seed({ retireNumber: '573009999999' });
    await expect(
      service.adopt(a.tenantId, a.keep.id, a.retire.id),
    ).rejects.toThrow(/distintos/);

    const b = await seed();
    await expect(
      service.adopt(randomUUID(), b.keep.id, b.retire.id),
    ).rejects.toThrow(/no existe/);
    expect(
      await prisma.whatsAppConnection.count({
        where: { tenantId: b.tenantId },
      }),
    ).toBe(2);
  });

  it('rechaza si la nueva no tiene número y no estaba conectada', async () => {
    const { tenantId, keep, retire } = await seed();
    await prisma.whatsAppConnection.update({
      where: { id: retire.id },
      data: { status: 'ERROR' },
    });
    await expect(service.adopt(tenantId, keep.id, retire.id)).rejects.toThrow(
      /no está conectada/,
    );
  });

  it('si falla a mitad de la transacción se revierte todo y la conexión corriendo se reinicia', async () => {
    const { tenantId, keep, retire } = await seed();
    await prisma.whatsAppContact.createMany({
      data: [
        { connectionId: keep.id, address: 'A', optedOutAt: new Date() },
        { connectionId: retire.id, address: 'A' },
        { connectionId: retire.id, address: 'B', optedOutAt: new Date() },
      ],
    });
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION phase2_block_delete() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'fallo simulado'; END; $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER phase2_block BEFORE DELETE ON "WhatsAppConnection"
      FOR EACH ROW WHEN (OLD.id = '${retire.id}') EXECUTE FUNCTION phase2_block_delete()`);

    try {
      await expect(
        service.adopt(tenantId, keep.id, retire.id),
      ).rejects.toThrow();
    } finally {
      await prisma.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS phase2_block ON "WhatsAppConnection"`,
      );
      await prisma.$executeRawUnsafe(
        `DROP FUNCTION IF EXISTS phase2_block_delete()`,
      );
    }

    expect(
      await prisma.whatsAppContact.count({ where: { connectionId: keep.id } }),
    ).toBe(1);
    expect(
      await prisma.whatsAppContact.count({
        where: { connectionId: retire.id },
      }),
    ).toBe(2);
    expect(
      await prisma.whatsAppContact.count({
        where: { connectionId: retire.id, optedOutAt: { not: null } },
      }),
    ).toBe(1);
    expect(
      (
        await prisma.whatsAppSession.findMany({
          where: { connectionId: keep.id },
        })
      ).map((x) => x.key),
    ).toEqual(['old']);
    expect(
      await prisma.whatsAppSession.count({
        where: { connectionId: retire.id },
      }),
    ).toBe(2);
    expect(
      await prisma.whatsAppConnectionAudit.count({ where: { tenantId } }),
    ).toBe(0);
    expect(
      (
        await prisma.whatsAppConnection.findUniqueOrThrow({
          where: { id: keep.id },
        })
      ).status,
    ).toBe('ERROR');
    expect(sessionManager.start).toHaveBeenCalledWith(retire.id);
    expect(sessionManager.start).not.toHaveBeenCalledWith(keep.id);
  });
});
