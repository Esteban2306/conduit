import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { PrismaService } from 'src/shared/prisma.service';
import {
  SEALED_PREFIX,
  SecretEncryptionService,
} from 'src/shared/security/secret-encryption.service';

@Injectable()
export class AiKeyEncryptionMigration implements OnApplicationBootstrap {
  private readonly logger = new Logger(AiKeyEncryptionMigration.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: SecretEncryptionService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      const sealed = await this.sealLegacyKeys();
      if (sealed > 0) {
        this.logger.warn(
          `${sealed} API key(s) de modelos de IA se cifraron en la base. ` +
            `Si alguna pasó por el navegador o por los registros, rótala (ver ESPECIFICACIONES_TECNICAS.md).`,
        );
      }
    } catch (error) {
      this.logger.error(
        `No fue posible cifrar las API keys existentes: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async sealLegacyKeys(): Promise<number> {
    const legacy = await this.prisma.aiModelConfig.findMany({
      where: { NOT: { apiKey: { startsWith: SEALED_PREFIX } } },
      select: { id: true, apiKey: true, apiKeyLast4: true },
    });

    let sealed = 0;
    for (const row of legacy) {
      const { count } = await this.prisma.aiModelConfig.updateMany({
        where: { id: row.id, apiKey: row.apiKey },
        data: {
          apiKey: this.encryption.seal(row.apiKey),
          apiKeyLast4: row.apiKeyLast4 ?? this.encryption.last4(row.apiKey),
        },
      });
      sealed += count;
    }
    return sealed;
  }
}
