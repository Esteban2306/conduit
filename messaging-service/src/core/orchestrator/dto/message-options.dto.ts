import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsISO8601, IsOptional, IsString, IsUrl } from 'class-validator';

export class MessageOptionsDto {
  @ApiPropertyOptional({
    example: '2026-06-01T09:00:00.000Z',
    description:
      'Fecha ISO 8601 para envío programado. Si se omite, se envía de inmediato.',
  })
  @IsISO8601({}, { message: 'scheduledAt debe ser una fecha ISO 8601 válida' })
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

  @ApiPropertyOptional({ example: 'https://miapp.com/webhooks/mensajes' })
  @IsUrl({}, { message: 'webhookUrl debe ser una URL válida' })
  @IsOptional()
  webhookUrl?: string;
}
