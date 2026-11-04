import {
  IsString,
  IsArray,
  IsOptional,
  IsObject,
  ValidateNested,
  IsUUID,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

class RecipientDto {
  @ApiProperty({ example: 'juan@gmail.com' })
  @IsString()
  address: string;

  @ApiPropertyOptional({ example: 'Juan Pérez' })
  @IsString()
  @IsOptional()
  name?: string;

  @ApiPropertyOptional({
    description: 'Variables específicas para este destinatario',
    example: { nombre: 'Juan', pedido: '12345' },
  })
  @IsObject()
  @IsOptional()
  variables?: Record<string, unknown>;
}

class BulkOptionsDto {
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

  @ApiPropertyOptional({ example: '2026-05-29T09:00:00.000Z' })
  @IsString()
  @IsOptional()
  scheduledAt?: string;
}

export class BulkDispatchDto {
  @ApiProperty({
    description: 'UUID del template a usar para todos los destinatarios',
  })
  @IsUUID()
  templateId: string;

  @ApiProperty({
    description: 'Lista de destinatarios con sus variables individuales',
    type: [RecipientDto],
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RecipientDto)
  recipients: RecipientDto[];

  @IsUUID('4', { message: 'connectionId debe ser un UUID v4 válido' })
  @IsOptional()
  connectionId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @ValidateNested()
  @Type(() => BulkOptionsDto)
  options?: BulkOptionsDto;
}
