import { Prisma, PrismaClient } from '@prisma/client';
import { BufferJSON, initAuthCreds, proto } from '@whiskeysockets/baileys';

export const ENCRYPTED_FIELD = '__enc';
export const CREDS_BACKUP_INTERVAL_MS = 30 * 60_000;
const WRITE_RETRIES = [200, 800];

const SESSION_TYPE = {
  CREDS: 'creds',
  KEY: 'key',
} as const;

export interface SessionCodec {
  seal(plain: string): string;
  open(stored: string): string;
}

/** La clave maestra no corresponde a la usada al cifrar la sesión: no se debe crear una sesión nueva. */
export class SessionDecryptError extends Error {
  constructor(connectionId: string, cause: unknown) {
    super(
      `No fue posible descifrar la sesión de WhatsApp de la conexión ${connectionId}: ` +
        `INTEGRATION_ENCRYPTION_KEY no corresponde a la usada al guardarla. ` +
        `No se crea una sesión nueva para no obligar a escanear otro QR; restaura la clave original. ` +
        `(${cause instanceof Error ? cause.message : String(cause)})`,
    );
    this.name = 'SessionDecryptError';
  }
}

export function encodeSessionValue(value: unknown, codec: SessionCodec) {
  const json = JSON.stringify(value, BufferJSON.replacer);
  return { [ENCRYPTED_FIELD]: codec.seal(json) };
}

export function decodeSessionValue(
  data: unknown,
  codec: SessionCodec,
  connectionId: string,
): unknown {
  if (data && typeof data === 'object' && ENCRYPTED_FIELD in data) {
    let json: string;
    try {
      json = codec.open((data as Record<string, string>)[ENCRYPTED_FIELD]);
    } catch (error) {
      throw new SessionDecryptError(connectionId, error);
    }
    return JSON.parse(json, BufferJSON.reviver);
  }
  return JSON.parse(JSON.stringify(data), BufferJSON.reviver);
}

export function isIdentityIntact(creds: unknown): boolean {
  const c = creds as {
    noiseKey?: unknown;
    signedIdentityKey?: unknown;
    registrationId?: unknown;
  } | null;
  return (
    !!c &&
    !!c.noiseKey &&
    !!c.signedIdentityKey &&
    c.registrationId !== undefined
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function withRetries<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= WRITE_RETRIES.length; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < WRITE_RETRIES.length) await sleep(WRITE_RETRIES[attempt]);
    }
  }
  throw lastError;
}

/**
 * Sesión de Baileys en Postgres. Cada valor se guarda cifrado (AES-256-GCM
 * con la clave maestra); los valores guardados antes del cifrado se siguen
 * leyendo y la migración de arranque los cifra. Las escrituras de claves son
 * atómicas por lote, las de credenciales van en cola y se reintentan, nunca
 * se pisan unas credenciales registradas con unas sin registrar, y hay una
 * copia de seguridad de las credenciales (la identidad del dispositivo).
 */
export async function usePrismaAuthState(
  prisma: PrismaClient,
  connectionId: string,
  codec: SessionCodec,
) {
  const where = (type: string, key: string) => ({
    connectionId_type_key: { connectionId, type, key },
  });

  async function readRaw(type: string, key: string) {
    return prisma.whatsAppSession.findUnique({
      where: where(type, key),
      select: { data: true, updatedAt: true },
    });
  }

  async function writeValue(type: string, key: string, value: unknown) {
    const data = encodeSessionValue(value, codec) as Prisma.InputJsonValue;
    await withRetries(() =>
      prisma.whatsAppSession.upsert({
        where: where(type, key),
        create: { connectionId, type, key, data },
        update: { data, updatedAt: new Date() },
      }),
    );
  }

  let sawCredsRow = false;

  async function loadCreds() {
    const main = await readRaw(SESSION_TYPE.CREDS, 'main');
    sawCredsRow ||= !!main;
    if (main) {
      const decoded = decodeSessionValue(main.data, codec, connectionId);
      if (isIdentityIntact(decoded)) return { creds: decoded, from: 'main' };
    }
    const backup = await readRaw(SESSION_TYPE.CREDS, 'backup');
    sawCredsRow ||= !!backup;
    if (backup) {
      const decoded = decodeSessionValue(backup.data, codec, connectionId);
      if (isIdentityIntact(decoded)) return { creds: decoded, from: 'backup' };
    }
    return null;
  }

  const loaded = await loadCreds();
  const creds = (loaded?.creds ?? initAuthCreds()) as ReturnType<
    typeof initAuthCreds
  >;
  let restoredFromBackup = loaded?.from === 'backup';
  const identityLost = !loaded && sawCredsRow;

  const backupRow = await readRaw(SESSION_TYPE.CREDS, 'backup');
  let lastBackupAt = backupRow?.updatedAt.getTime() ?? 0;

  let writing: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const run = writing.then(task, task);
    writing = run.catch(() => undefined);
    return run;
  };

  return {
    restoredFromBackup: () => restoredFromBackup,
    identityLost,
    state: {
      creds,
      keys: {
        get: async (type: string, ids: string[]) => {
          const data: Record<string, unknown> = {};
          if (ids.length === 0) return data;
          const rows = await prisma.whatsAppSession.findMany({
            where: {
              connectionId,
              type: SESSION_TYPE.KEY,
              key: { in: ids.map((id) => `${type}:${id}`) },
            },
            select: { key: true, data: true },
          });
          for (const row of rows) {
            const id = row.key.slice(type.length + 1);
            const value = decodeSessionValue(row.data, codec, connectionId);
            data[id] =
              type === 'app-state-sync-key'
                ? proto.Message.AppStateSyncKeyData.fromObject(value as object)
                : value;
          }
          return data;
        },
        set: async (data: Record<string, Record<string, unknown>>) => {
          const writes: Array<{ key: string; encoded: Prisma.InputJsonValue }> =
            [];
          const deletes: string[] = [];
          for (const [type, entries] of Object.entries(data)) {
            for (const [id, value] of Object.entries(entries ?? {})) {
              const key = `${type}:${id}`;
              if (value) {
                writes.push({
                  key,
                  encoded: encodeSessionValue(
                    value,
                    codec,
                  ) as Prisma.InputJsonValue,
                });
              } else {
                deletes.push(key);
              }
            }
          }
          if (writes.length === 0 && deletes.length === 0) return;
          await withRetries(() =>
            prisma.$transaction([
              ...writes.map(({ key, encoded }) =>
                prisma.whatsAppSession.upsert({
                  where: where(SESSION_TYPE.KEY, key),
                  create: {
                    connectionId,
                    type: SESSION_TYPE.KEY,
                    key,
                    data: encoded,
                  },
                  update: { data: encoded, updatedAt: new Date() },
                }),
              ),
              ...(deletes.length > 0
                ? [
                    prisma.whatsAppSession.deleteMany({
                      where: {
                        connectionId,
                        type: SESSION_TYPE.KEY,
                        key: { in: deletes },
                      },
                    }),
                  ]
                : []),
            ]),
          );
        },
      },
    },
    saveCreds: () =>
      enqueue(async () => {
        if (!creds.registered) {
          const existing = await loadCreds();
          if (
            existing &&
            (existing.creds as { registered?: boolean }).registered
          ) {
            throw new Error(
              `Se evitó pisar las credenciales registradas de ${connectionId} con unas sin registrar.`,
            );
          }
        }
        await writeValue(SESSION_TYPE.CREDS, 'main', creds);
        restoredFromBackup = false;
        if (
          creds.registered &&
          Date.now() - lastBackupAt >= CREDS_BACKUP_INTERVAL_MS
        ) {
          await writeValue(SESSION_TYPE.CREDS, 'backup', creds);
          lastBackupAt = Date.now();
        }
      }),
  };
}
