import { PrismaClient } from '@prisma/client';
import {
  AuthenticationState,
  SignalDataTypeMap,
  initAuthCreds,
  BufferJSON,
} from '@whiskeysockets/baileys';

const SESSION_ID = 'accessToken';

const TYPE_MAP: Record<string, string> = {
  'pre-key': 'pre-key',
  session: 'accessToken',
  'identity-key': 'identity-key',
  'sender-key': 'sender-key',
  'sender-key-memory': 'sender-key-memory',
  'app-state-sync-key': 'app-state-sync-key',
  'app-state-sync-version': 'app-state-sync-version',
  'lid-mapping': 'lid-mapping',
  'device-list': 'device-list',
};

export async function usePrismaAuthState(
  prisma: PrismaClient,
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> {
  const credsKey = `${SESSION_ID}:creds:main`;
  const credsRecord = await prisma.whatsAppSession.findUnique({
    where: { id: credsKey },
  });

  const creds = credsRecord
    ? JSON.parse(JSON.stringify(credsRecord.data), BufferJSON.reviver)
    : initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data: Record<string, unknown> = {};

          const dbIds = ids.map((id) => `${SESSION_ID}:${type}:${id}`);

          const records = await prisma.whatsAppSession.findMany({
            where: { id: { in: dbIds } },
          });

          for (const record of records) {
            const originalId = record.id.replace(`${SESSION_ID}:${type}:`, '');
            data[originalId] = JSON.parse(
              JSON.stringify(record.data),
              BufferJSON.reviver,
            );
          }

          return data as any;
        },

        set: async (data) => {
          const upserts: Array<{ id: string; data: unknown }> = [];
          const deletes: string[] = [];

          for (const [type, categoryData] of Object.entries(data)) {
            if (!categoryData) continue;

            for (const [id, value] of Object.entries(categoryData)) {
              const dbId = `${SESSION_ID}:${type}:${id}`;

              if (value === null || value === undefined) {
                deletes.push(dbId);
              } else {
                const serialized = JSON.parse(
                  JSON.stringify(value, BufferJSON.replacer),
                );
                upserts.push({ id: dbId, data: serialized });
              }
            }
          }

          await Promise.all([
            deletes.length > 0
              ? prisma.whatsAppSession.deleteMany({
                  where: { id: { in: deletes } },
                })
              : Promise.resolve(),

            ...chunkArray(upserts, 50).map((chunk) =>
              Promise.all(
                chunk.map((item) =>
                  prisma.whatsAppSession.upsert({
                    where: { id: item.id },
                    update: { data: item.data as any },
                    create: { id: item.id, data: item.data as any },
                  }),
                ),
              ),
            ),
          ]);
        },
      },
    },

    saveCreds: async () => {
      const serialized = JSON.parse(JSON.stringify(creds, BufferJSON.replacer));
      await prisma.whatsAppSession.upsert({
        where: { id: credsKey },
        update: { data: serialized },
        create: { id: credsKey, data: serialized },
      });
    },
  };
}

function chunkArray<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}
