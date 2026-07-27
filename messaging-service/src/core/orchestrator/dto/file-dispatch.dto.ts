import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsUUID, IsOptional, IsObject } from 'class-validator';

export class FileDispatchDto {
  @ApiProperty({
    description:
      'UUID del template a usar para todos los destinatarios del archivo',
    example: 'uuid-del-template',
  })
  @IsUUID()
  templateId: string;

  @ApiPropertyOptional({
    description:
      'UUID de la conexión de WhatsApp a usar. Obligatorio si el archivo ' +
      'contiene destinatarios con channel=WHATSAPP, dado que un tenant puede ' +
      'tener múltiples conexiones activas.',
    example: 'e503eb66-bf29-4044-ad47-b3c102b406f6',
  })
  @IsUUID()
  @IsOptional()
  connectionId?: string;

  @ApiPropertyOptional({
    description:
      'Variables fijas que se aplican a todos los destinatarios (además de las columnas del archivo)',
    example: { empresa: 'Mi Negocio', promocion: '20% descuento' },
  })
  @IsObject()
  @IsOptional()
  extraVariables?: Record<string, unknown>;

  @ApiPropertyOptional({
    description:
      'Fecha programada ISO 8601 para todos los mensajes del archivo',
    example: '2026-05-30T09:00:00.000Z',
  })
  @IsString()
  @IsOptional()
  scheduledAt?: string;

  @ApiPropertyOptional({
    enum: ['low', 'normal', 'high'],
    default: 'normal',
    description:
      'Prioridad relativa dentro de la cola de envío. NO es una garantía de ' +
      'tiempo de entrega ni de SLA — es "mejor esfuerzo": un mensaje "high" ' +
      'se procesa antes que uno "normal" en igualdad de condiciones, pero si ' +
      'la cola está saturada, todos los mensajes (incluidos los "high") ' +
      'pueden demorar. Para tiempos garantizados, hablá de SLA con el equipo ' +
      'de infraestructura antes de comprometerlo con un cliente.',
  })
  @IsString()
  @IsOptional()
  priority?: 'low' | 'normal' | 'high';
}
