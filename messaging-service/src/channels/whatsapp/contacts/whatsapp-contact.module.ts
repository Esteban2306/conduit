import { Module } from '@nestjs/common';
import { WhatsAppContactService } from './WhatsAppContactService';

/**
 * Módulo hoja (solo depende de Prisma, que es global) para que tanto el
 * orquestador como los canales lo usen sin crear un ciclo de módulos.
 */
@Module({
  providers: [WhatsAppContactService],
  exports: [WhatsAppContactService],
})
export class WhatsAppContactModule {}
