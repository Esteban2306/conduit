import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({
  datasources: {
    db: { url: process.env.DATABASE_URL },
  },
});

export async function cleanDatabase(): Promise<void> {
  await prisma.webhookDelivery.deleteMany();
  await prisma.deadLetterMessage.deleteMany();
  await prisma.messageAttempt.deleteMany();
  await prisma.message.deleteMany();
  await prisma.template.deleteMany();
  await prisma.tenant.deleteMany();

  await prisma.tenant.create({
    data: {
      id: 'default',
      name: 'Default Tenant',
      slug: 'default',
      isActive: true,
    },
  });
}

export { prisma };
