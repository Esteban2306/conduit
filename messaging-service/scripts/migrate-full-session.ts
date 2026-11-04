import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

const BAILEYS_KEY_TYPES = [
  'app-state-sync-key',
  'app-state-sync-version',
  'identity-key',
  'lid-mapping',
  'device-list',
  'sender-key',
  'pre-key',
  'session',
] as const;

function getSessionKey(fileName: string): {
  type: 'creds' | 'key';
  key: string;
} {
  if (fileName === 'creds') {
    return { type: 'creds', key: 'main' };
  }

  const keyType = BAILEYS_KEY_TYPES.find((type) =>
    fileName.startsWith(`${type}-`),
  );
  if (!keyType) {
    throw new Error(
      `Nombre de archivo Baileys no reconocido: ${fileName}.json`,
    );
  }

  const legacyId = fileName.slice(keyType.length + 1).replace(/__/g, '/');
  if (!legacyId) {
    throw new Error(`El archivo ${fileName}.json no contiene una clave.`);
  }

  return { type: 'key', key: `${keyType}:${legacyId}` };
}

async function migrateFullSession() {
  const prisma = new PrismaClient();
  try {
    const connectionId = process.argv[2] ?? process.env.WHATSAPP_CONNECTION_ID;
    if (!connectionId) {
      throw new Error(
        'Indica el connectionId como primer argumento o en WHATSAPP_CONNECTION_ID.',
      );
    }

    const connection = await prisma.whatsAppConnection.findUnique({
      where: { id: connectionId },
      select: { id: true },
    });
    if (!connection) {
      throw new Error(`No existe WhatsAppConnection con id ${connectionId}.`);
    }

    const sessionPath = path.join(process.cwd(), 'baileys_session');
    if (!fs.existsSync(sessionPath)) {
      console.log('No hay directorio de sesión que migrar');
      return;
    }

    const files = fs.readdirSync(sessionPath);
    let migrated = 0;
    let failed = 0;

    for (const file of files) {
      if (!file.endsWith('.json')) continue;

      const filePath = path.join(sessionPath, file);
      const fileName = file.slice(0, -'.json'.length);

      try {
        const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        const { type, key } = getSessionKey(fileName);

        await prisma.whatsAppSession.upsert({
          where: { connectionId_type_key: { connectionId, type, key } },
          update: { data: content },
          create: { connectionId, type, key, data: content },
        });

        migrated++;
        if (migrated % 50 === 0) {
          console.log(`Migrados: ${migrated}/${files.length}`);
        }
      } catch (error) {
        failed++;
        console.error(
          `Error migrando ${file}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }

    console.log(
      `\nMigración completa: ${migrated} archivos migrados, ${failed} fallidos`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

migrateFullSession().catch((error: Error) => {
  console.error(`Error migrando sesión: ${error.message}`);
  process.exitCode = 1;
});
