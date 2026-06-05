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
    description: 'Prioridad de envío',
    enum: ['low', 'normal', 'high'],
    default: 'normal',
  })
  @IsString()
  @IsOptional()
  priority?: 'low' | 'normal' | 'high';
}
