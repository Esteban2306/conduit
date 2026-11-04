import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { PrismaService } from 'src/shared/prisma.service';
import { SecretEncryptionService } from 'src/shared/security/secret-encryption.service';
import { ENCRYPTED_FIELD } from './BaileysAuthState';

const BATCH = 200;

interface LegacyRow {
  id: string;
  data: unknown;
}

/**
 * Cifra las filas de sesión guardadas antes de que existiera el cifrado. Cada
 * fila se reemplaza solo si sigue idéntica a lo que se leyó, así que no pisa
 * lo que un socket activo escriba mientras tanto.
 */
@Injectable()
export class WhatsAppSessionEncryptionMigration implements OnApplicationBootstrap {
  private readonly logger = new Logger(WhatsAppSessionEncryptionMigration.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: SecretEncryptionService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      const sealed = await this.sealLegacyRows();
      if (sealed > 0) {
        this.logger.warn(
          `${sealed} fila(s) de sesión de WhatsApp se cifraron en la base. ` +
            `Guarda INTEGRATION_ENCRYPTION_KEY en un gestor de secretos: sin esa clave las sesiones no se pueden leer y habría que escanear un QR nuevo.`,
        );
      }
    } catch (error) {
      this.logger.error(
        `No fue posible cifrar las sesiones de WhatsApp existentes: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async sealLegacyRows(): Promise<number> {
    let total = 0;
    for (let pass = 0; pass < 1000; pass++) {
      const rows = await this.prisma.$queryRaw<LegacyRow[]>`
        SELECT id, data FROM "WhatsAppSession"
        WHERE data->${ENCRYPTED_FIELD} IS NULL
        LIMIT ${BATCH}
      `;
      if (rows.length === 0) break;

      let sealedInPass = 0;
      for (const row of rows) {
        const original = JSON.stringify(row.data);
        const sealed = JSON.stringify({
          [ENCRYPTED_FIELD]: this.encryption.seal(original),
        });
        const changed = await this.prisma.$executeRaw`
          UPDATE "WhatsAppSession"
          SET data = ${sealed}::jsonb, "updatedAt" = NOW()
          WHERE id = ${row.id}
            AND data->${ENCRYPTED_FIELD} IS NULL
            AND data = ${original}::jsonb
        `;
        sealedInPass += changed;
      }
      total += sealedInPass;
      if (sealedInPass === 0) break;
    }
    return total;
  }
}
