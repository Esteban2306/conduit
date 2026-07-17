import { PrismaClient } from '@prisma/client';
import { proto } from '@whiskeysockets/baileys';
import { BufferJSON, initAuthCreds } from '@whiskeysockets/baileys';

export async function usePrismaAuthState(
  prisma: PrismaClient,
  connectionId: string,
) {
  const SESSION_TYPE = {
    CREDS: 'creds',
    KEY: 'key',
  } as const;

  async function readData(type: string, key: string): Promise<any> {
    const record = await prisma.whatsAppSession.findUnique({
      where: { connectionId_type_key: { connectionId, type, key } },
      select: { data: true },
    });
    if (!record) return null;
    return JSON.parse(JSON.stringify(record.data), BufferJSON.reviver);
  }

  async function writeData(
    type: string,
    key: string,
    data: any,
  ): Promise<void> {
    const serialized = JSON.parse(JSON.stringify(data, BufferJSON.replacer));
    await prisma.whatsAppSession.upsert({
      where: { connectionId_type_key: { connectionId, type, key } },
      create: { connectionId, type, key, data: serialized },
      update: { data: serialized, updatedAt: new Date() },
    });
  }

  async function removeData(type: string, key: string): Promise<void> {
    await prisma.whatsAppSession.deleteMany({
      where: { connectionId, type, key },
    });
  }

  const creds = (await readData(SESSION_TYPE.CREDS, 'main')) ?? initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type: string, ids: string[]) => {
          const data: Record<string, any> = {};
          await Promise.all(
            ids.map(async (id) => {
              const value = await readData(SESSION_TYPE.KEY, `${type}:${id}`);
              if (value) {
                if (type === 'app-state-sync-key') {
                  data[id] =
                    proto.Message.AppStateSyncKeyData.fromObject(value);
                } else {
                  data[id] = value;
                }
              }
            }),
          );
          return data;
        },
        set: async (data: Record<string, Record<string, any>>) => {
          await Promise.all(
            Object.entries(data).flatMap(([type, entries]) =>
              Object.entries(entries ?? {}).map(([id, value]) => {
                if (value) {
                  return writeData(SESSION_TYPE.KEY, `${type}:${id}`, value);
                } else {
                  return removeData(SESSION_TYPE.KEY, `${type}:${id}`);
                }
              }),
            ),
          );
        },
      },
    },
    saveCreds: async () => {
      await writeData(SESSION_TYPE.CREDS, 'main', creds);
    },
  };
}
