jest.mock('@whiskeysockets/baileys', () => {
  const BufferJSON = {
    replacer: (_k: string, v: unknown) =>
      Buffer.isBuffer(v)
        ? { type: 'Buffer', data: (v as Buffer).toString('base64') }
        : v,
    reviver: (_k: string, v: unknown) =>
      v && typeof v === 'object' && (v as { type?: string }).type === 'Buffer'
        ? Buffer.from((v as { data: string }).data, 'base64')
        : v,
  };
  return {
    __esModule: true,
    BufferJSON,
    initAuthCreds: () => ({
      registered: false,
      registrationId: 1,
      noiseKey: Buffer.from('n'),
      signedIdentityKey: Buffer.from('i'),
    }),
    proto: {
      Message: { AppStateSyncKeyData: { fromObject: (v: unknown) => v } },
    },
  };
});

import {
  CREDS_BACKUP_INTERVAL_MS,
  ENCRYPTED_FIELD,
  SessionDecryptError,
  usePrismaAuthState,
} from 'src/channels/whatsapp/baileys/BaileysAuthState';
import { SecretEncryptionService } from 'src/shared/security/secret-encryption.service';
import { WhatsAppSessionEncryptionMigration } from 'src/channels/whatsapp/baileys/WhatsAppSessionEncryptionMigration';

type Row = { type: string; key: string; data: unknown; updatedAt: Date };

function encryption(hexKey: string) {
  const service = new SecretEncryptionService({
    get: () => hexKey,
  } as never);
  service.onModuleInit();
  return service;
}
const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);

function fakePrisma(initial: Row[] = []) {
  const rows = new Map<string, Row>(
    initial.map((r) => [`${r.type}|${r.key}`, r]),
  );
  const calls = { findMany: 0, transactions: 0, failNextUpsert: 0 };
  const at = (type: string, key: string) => rows.get(`${type}|${key}`);
  const prisma = {
    rows,
    calls,
    whatsAppSession: {
      findUnique: jest.fn(async ({ where }: any) => {
        const { type, key } = where.connectionId_type_key;
        return at(type, key) ?? null;
      }),
      findMany: jest.fn(async ({ where }: any) => {
        calls.findMany++;
        return [...rows.values()].filter(
          (r) => r.type === where.type && where.key.in.includes(r.key),
        );
      }),
      upsert: jest.fn(async ({ where, create, update }: any) => {
        if (calls.failNextUpsert > 0) {
          calls.failNextUpsert--;
          throw new Error('conexión caída');
        }
        const { type, key } = where.connectionId_type_key;
        const existing = at(type, key);
        const row = {
          type,
          key,
          data: existing ? update.data : create.data,
          updatedAt: new Date(),
        };
        rows.set(`${type}|${key}`, row);
        return row;
      }),
      deleteMany: jest.fn(async ({ where }: any) => {
        for (const k of where.key.in) rows.delete(`${where.type}|${k}`);
        return { count: where.key.in.length };
      }),
    },
    $transaction: jest.fn(async (ops: Array<Promise<unknown>>) => {
      calls.transactions++;
      return Promise.all(ops);
    }),
  };
  return prisma;
}

const codec = (service: SecretEncryptionService) => ({
  seal: (v: string) => service.seal(v),
  open: (v: string) => service.open(v),
});

describe('BaileysAuthState: cifrado y persistencia de la sesión', () => {
  it('guarda las credenciales y las claves cifradas y las vuelve a leer idénticas', async () => {
    const prisma = fakePrisma();
    const service = encryption(KEY_A);
    const first = await usePrismaAuthState(
      prisma as never,
      'c1',
      codec(service),
    );
    first.state.creds.registered = true;
    await first.saveCreds();
    await first.state.keys.set({
      'pre-key': {
        '1': { private: Buffer.from('secreto'), public: Buffer.from('pub') },
      },
    });

    for (const row of prisma.rows.values()) {
      expect(row.data).toHaveProperty(ENCRYPTED_FIELD);
      expect(JSON.stringify(row.data)).not.toContain('secreto');
    }

    const second = await usePrismaAuthState(
      prisma as never,
      'c1',
      codec(service),
    );
    expect(second.state.creds.registered).toBe(true);
    const keys = await second.state.keys.get('pre-key', ['1', '2']);
    expect(Buffer.isBuffer((keys['1'] as { private: Buffer }).private)).toBe(
      true,
    );
    expect((keys['1'] as { private: Buffer }).private.toString()).toBe(
      'secreto',
    );
    expect(keys['2']).toBeUndefined();
  });

  it('lee sin problema las filas guardadas antes del cifrado', async () => {
    const legacyCreds = {
      registered: true,
      registrationId: 7,
      noiseKey: { type: 'Buffer', data: Buffer.from('n').toString('base64') },
      signedIdentityKey: {
        type: 'Buffer',
        data: Buffer.from('i').toString('base64'),
      },
    };
    const prisma = fakePrisma([
      { type: 'creds', key: 'main', data: legacyCreds, updatedAt: new Date() },
      {
        type: 'key',
        key: 'session:abc',
        data: { type: 'Buffer', data: Buffer.from('viejo').toString('base64') },
        updatedAt: new Date(),
      },
    ]);
    const state = await usePrismaAuthState(
      prisma as never,
      'c1',
      codec(encryption(KEY_A)),
    );
    expect(state.state.creds.registrationId).toBe(7);
    const keys = await state.state.keys.get('session', ['abc']);
    expect((keys.abc as Buffer).toString()).toBe('viejo');
  });

  it('con otra clave maestra no inventa una sesión nueva: falla con un error claro', async () => {
    const prisma = fakePrisma();
    const first = await usePrismaAuthState(
      prisma as never,
      'c1',
      codec(encryption(KEY_A)),
    );
    first.state.creds.registered = true;
    await first.saveCreds();

    await expect(
      usePrismaAuthState(prisma as never, 'c1', codec(encryption(KEY_B))),
    ).rejects.toBeInstanceOf(SessionDecryptError);
    await expect(
      usePrismaAuthState(prisma as never, 'c1', codec(encryption(KEY_B))),
    ).rejects.toThrow(/INTEGRATION_ENCRYPTION_KEY/);
  });

  it('un lote de claves se escribe en una sola transacción y se reintenta si la base falla un instante', async () => {
    const prisma = fakePrisma();
    const state = await usePrismaAuthState(
      prisma as never,
      'c1',
      codec(encryption(KEY_A)),
    );
    prisma.calls.failNextUpsert = 1;
    await state.state.keys.set({
      'pre-key': { '1': { a: 1 }, '2': { a: 2 } },
      session: { x: { b: 1 } },
    });
    expect(prisma.rows.size).toBe(3);

    await state.state.keys.set({ 'pre-key': { '1': null as never } });
    expect(prisma.rows.has('key|pre-key:1')).toBe(false);
    expect(prisma.rows.has('key|pre-key:2')).toBe(true);
    expect(prisma.calls.transactions).toBeGreaterThanOrEqual(2);
  });

  it('leer varias claves es una sola consulta', async () => {
    const prisma = fakePrisma();
    const state = await usePrismaAuthState(
      prisma as never,
      'c1',
      codec(encryption(KEY_A)),
    );
    await state.state.keys.set({
      'pre-key': { '1': { a: 1 }, '2': { a: 2 }, '3': { a: 3 } },
    });
    prisma.calls.findMany = 0;
    await state.state.keys.get('pre-key', ['1', '2', '3']);
    expect(prisma.calls.findMany).toBe(1);
  });

  it('unas credenciales sin registrar nunca pisan unas registradas', async () => {
    const prisma = fakePrisma();
    const service = encryption(KEY_A);
    const registered = await usePrismaAuthState(
      prisma as never,
      'c1',
      codec(service),
    );
    registered.state.creds.registered = true;
    await registered.saveCreds();
    const before = JSON.stringify([...prisma.rows.values()].map((r) => r.data));

    const accidental = await usePrismaAuthState(
      prisma as never,
      'c1',
      codec(service),
    );
    accidental.state.creds.registered = false;
    await expect(accidental.saveCreds()).rejects.toThrow(/Se evitó pisar/);
    expect(JSON.stringify([...prisma.rows.values()].map((r) => r.data))).toBe(
      before,
    );
  });

  it('guarda una copia de las credenciales como máximo cada 30 minutos y la usa si las principales se dañan', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-27T10:00:00Z') });
    try {
      const prisma = fakePrisma();
      const service = encryption(KEY_A);
      const state = await usePrismaAuthState(
        prisma as never,
        'c1',
        codec(service),
      );
      state.state.creds.registered = true;
      await state.saveCreds();
      const backup1 = prisma.rows.get('creds|backup')!;
      expect(backup1).toBeDefined();

      jest.setSystemTime(Date.now() + 5 * 60_000);
      await state.saveCreds();
      expect(prisma.rows.get('creds|backup')).toBe(backup1);

      jest.setSystemTime(Date.now() + CREDS_BACKUP_INTERVAL_MS);
      await state.saveCreds();
      expect(prisma.rows.get('creds|backup')).not.toBe(backup1);

      prisma.rows.set('creds|main', {
        type: 'creds',
        key: 'main',
        data: { corrupto: true },
        updatedAt: new Date(),
      });
      const recovered = await usePrismaAuthState(
        prisma as never,
        'c1',
        codec(service),
      );
      expect(recovered.restoredFromBackup()).toBe(true);
      expect(recovered.state.creds.registered).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('sin credenciales válidas ni copia lo avisa (habrá que escanear QR) en vez de fingir normalidad', async () => {
    const prisma = fakePrisma([
      {
        type: 'creds',
        key: 'main',
        data: { corrupto: true },
        updatedAt: new Date(),
      },
    ]);
    const state = await usePrismaAuthState(
      prisma as never,
      'c1',
      codec(encryption(KEY_A)),
    );
    expect(state.identityLost).toBe(true);
    expect(state.state.creds.registered).toBe(false);
  });

  it('las escrituras de credenciales no se cruzan: se hacen en orden', async () => {
    const prisma = fakePrisma();
    const state = await usePrismaAuthState(
      prisma as never,
      'c1',
      codec(encryption(KEY_A)),
    );
    state.state.creds.registered = true;
    const order: number[] = [];
    const original = prisma.whatsAppSession.upsert.getMockImplementation()!;
    prisma.whatsAppSession.upsert.mockImplementation(async (args: any) => {
      order.push(order.length);
      await new Promise((r) => setTimeout(r, order.length === 1 ? 20 : 0));
      return original(args);
    });
    await Promise.all([
      state.saveCreds(),
      state.saveCreds(),
      state.saveCreds(),
    ]);
    expect(order.length).toBeGreaterThanOrEqual(3);
  });
});

describe('WhatsAppSessionEncryptionMigration', () => {
  it('cifra las filas viejas con compare-and-set y las deja legibles', async () => {
    const service = encryption(KEY_A);
    const stored = [
      { id: 'r1', data: { type: 'Buffer', data: 'dmlqbw==' } },
      { id: 'r2', data: { registered: true } },
    ];
    const updates: Array<{ id: string; sealed: string; original: string }> = [];
    const prisma = {
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce(stored)
        .mockResolvedValueOnce([]),
      $executeRaw: jest.fn(
        async (_s: TemplateStringsArray, ...values: unknown[]) => {
          updates.push({
            sealed: values[0] as string,
            id: values[1] as string,
            original: values[3] as string,
          });
          return 1;
        },
      ),
    };
    const migration = new WhatsAppSessionEncryptionMigration(
      prisma as never,
      service,
    );
    expect(await migration.sealLegacyRows()).toBe(2);
    for (const update of updates) {
      const payload = JSON.parse(update.sealed) as Record<string, string>;
      expect(JSON.parse(service.open(payload[ENCRYPTED_FIELD]))).toEqual(
        JSON.parse(update.original),
      );
    }
  });

  it('si una fila cambió mientras tanto (un socket la escribió) no la pisa', async () => {
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'r1', data: { a: 1 } }]),
      $executeRaw: jest.fn().mockResolvedValue(0),
    };
    const migration = new WhatsAppSessionEncryptionMigration(
      prisma as never,
      encryption(KEY_A),
    );
    expect(await migration.sealLegacyRows()).toBe(0);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });
});
