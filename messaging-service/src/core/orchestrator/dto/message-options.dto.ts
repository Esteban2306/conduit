import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsISO8601, IsOptional, IsUrl } from 'class-validator';

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
    example: 'high',
  })
  @IsIn(['low', 'normal', 'high'], {
    message: 'priority debe ser low, normal o high',
  })
  @IsOptional()
  priority?: 'low' | 'normal' | 'high';

  @ApiPropertyOptional({ example: 'https://miapp.com/webhooks/mensajes' })
  @IsUrl({}, { message: 'webhookUrl debe ser una URL válida' })
  @IsOptional()
  webhookUrl?: string;
}
