import { PrismaClient } from '@prisma/client';

export function createTestPrisma(databaseUrl: string): PrismaClient {
  return new PrismaClient({ datasources: { db: { url: databaseUrl } } });
}

export async function createTestTenant(
  prisma: PrismaClient,
  tenantId: string,
): Promise<void> {
  await prisma.tenant.create({
    data: {
      id: tenantId,
      name: `Tenant de prueba ${tenantId}`,
      slug: tenantId,
      isActive: true,
    },
  });
}

export async function deleteTestTenant(
  prisma: PrismaClient,
  tenantId: string,
): Promise<void> {
  const messages = { message: { tenantId } };
  await prisma.webhookDelivery.deleteMany({ where: messages });
  await prisma.deadLetterMessage.deleteMany({ where: messages });
  await prisma.messageAttempt.deleteMany({ where: messages });
  await prisma.message.deleteMany({ where: { tenantId } });
  await prisma.tenant.deleteMany({ where: { id: tenantId } });
}
