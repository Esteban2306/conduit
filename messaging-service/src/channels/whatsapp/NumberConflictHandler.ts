import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WhatsAppConnectionStatus } from '@prisma/client';
import { LineAdoptionService } from './LineAdoption.service';
import type { NumberConflict } from './baileys/BaileysSessionManager';

const IDLE: string[] = [
  WhatsAppConnectionStatus.ERROR,
  WhatsAppConnectionStatus.DISCONNECTED,
];

@Injectable()
export class NumberConflictHandler {
  private readonly logger = new Logger(NumberConflictHandler.name);

  constructor(
    private readonly config: ConfigService,
    private readonly adoption: LineAdoptionService,
  ) {}

  handle = (conflict: NumberConflict): void => {
    if (!this.config.get<boolean>('channels.lineAutoAdopt')) return;

    if (!IDLE.includes(conflict.existing.status)) {
      this.logger.warn(
        `No se adopta automáticamente: la conexión ${conflict.existing.id} está ${conflict.existing.status}, no inactiva.`,
      );
      return;
    }

    void this.adoption
      .adopt(
        conflict.tenantId,
        conflict.existing.id,
        conflict.newConnectionId,
        'auto-adopt',
      )
      .catch((error: unknown) => {
        this.logger.error(
          `La adopción automática de ${conflict.newConnectionId} en ${conflict.existing.id} falló: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
  };
}
