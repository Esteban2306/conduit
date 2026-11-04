import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

async function migrate() {
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
    const credsPath = path.join(sessionPath, 'creds.json');

    if (!fs.existsSync(credsPath)) {
      console.log('No hay creds.json que migrar');
      return;
    }

    const creds = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));

    await prisma.whatsAppSession.upsert({
      where: {
        connectionId_type_key: { connectionId, type: 'creds', key: 'main' },
      },
      update: { data: creds },
      create: { connectionId, type: 'creds', key: 'main', data: creds },
    });

    console.log('✅ Credenciales migradas a PostgreSQL');
  } finally {
    await prisma.$disconnect();
  }
}

migrate().catch((error: Error) => {
  console.error(`Error migrando credenciales: ${error.message}`);
  process.exitCode = 1;
});
