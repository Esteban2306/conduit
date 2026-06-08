import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

async function migrate() {
  const prisma = new PrismaClient();
  const sessionPath = path.join(process.cwd(), 'baileys_session');
  const credsPath = path.join(sessionPath, 'creds.json');

  if (!fs.existsSync(credsPath)) {
    console.log('No hay creds.json que migrar');
    return;
  }

  const creds = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));

  await prisma.whatsAppSession.upsert({
    where: { id: 'default-session:creds:main' },
    update: { data: creds },
    create: { id: 'default-session:creds:main', data: creds },
  });

  console.log('✅ Credenciales migradas a PostgreSQL');
  await prisma.$disconnect();
}

migrate();
