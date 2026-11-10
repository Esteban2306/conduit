import { PrismaClient } from '@prisma/client';
import { backfillSpecialists } from './backfill-specialists';

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv
    .find((arg) => arg.startsWith(prefix))
    ?.slice(prefix.length);
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const tenantId = argument('tenant');
  const databaseName = (() => {
    try {
      return new URL(process.env.DATABASE_URL ?? '').pathname.slice(1);
    } catch {
      return '(desconocida)';
    }
  })();

  const prisma = new PrismaClient();
  try {
    console.log(
      `Base: ${databaseName} | modo: ${apply ? 'APLICAR' : 'SIMULACIÓN (usa --apply para escribir)'}${tenantId ? ` | tenant: ${tenantId}` : ''}`,
    );
    const report = await backfillSpecialists(prisma, { apply, tenantId });
    console.log(
      `Bots con modelo de imagen: ${report.examined} | ${apply ? 'creados' : 'a crear'}: ${report.created.length} | omitidos: ${report.skipped.length}`,
    );
    for (const entry of report.created) {
      console.log(
        `  + bot ${entry.botConfigId} -> ${entry.specialistKey ?? '(simulado)'} con ${entry.models} modelo(s)`,
      );
    }
    for (const skip of report.skipped) {
      console.log(
        `  - bot ${skip.botConfigId}: ${skip.reason}${skip.detail ? ` (${skip.detail})` : ''}`,
      );
    }
    if (report.skipped.some((s) => s.reason === 'ERROR')) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

void main();
