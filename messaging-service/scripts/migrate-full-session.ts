import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

async function migrateFullSession() {
  const prisma = new PrismaClient();
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
    const fileName = file.replace('.json', '');

    try {
      const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

      let id: string;

      if (fileName === 'creds') {
        id = 'default-session:creds:main';
      } else {
        const parts = fileName.split('-');
        const lastPart = parts[parts.length - 1];

        if (fileName.startsWith('pre-key-')) {
          id = `default-session:pre-key:${fileName.replace('pre-key-', '')}`;
        } else if (fileName.startsWith('session-')) {
          id = `default-session:session:${fileName.replace('session-', '')}`;
        } else if (fileName.startsWith('identity-key-')) {
          id = `default-session:identity-key:${fileName.replace('identity-key-', '')}`;
        } else if (fileName.startsWith('sender-key-')) {
          id = `default-session:sender-key:${fileName.replace('sender-key-', '')}`;
        } else if (fileName.startsWith('lid-mapping-')) {
          id = `default-session:lid-mapping:${fileName.replace('lid-mapping-', '')}`;
        } else if (fileName.startsWith('device-list-')) {
          id = `default-session:device-list:${fileName.replace('device-list-', '')}`;
        } else {
          id = `default-session:misc:${fileName}`;
        }
      }

      await prisma.whatsAppSession.upsert({
        where: { id },
        update: { data: content },
        create: { id, data: content },
      });

      migrated++;
      if (migrated % 50 === 0) {
        console.log(`Migrados: ${migrated}/${files.length}`);
      }
    } catch (error) {
      failed++;
      console.error(`Error migrando ${file}:`, error.message);
    }
  }

  console.log(
    `\nMigración completa: ${migrated} archivos migrados, ${failed} fallidos`,
  );
  await prisma.$disconnect();
}

migrateFullSession();
