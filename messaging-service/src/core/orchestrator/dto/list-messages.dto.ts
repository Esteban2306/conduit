import { ApiPropertyOptional } from '@nestjs/swagger';
import { MessageStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

export class ListMessageDto {
  @ApiPropertyOptional({
    description: 'Tipo de cola',
    enum: ['immediate', 'scheduled', 'all'],
    default: 'all',
  })
  @IsOptional()
  @IsString()
  queue: 'immediate' | 'scheduled' | 'all' = 'all';

  @ApiPropertyOptional({
    description: 'estado actual de la cola',
    enum: [
      'PENDING',
      'QUEUED',
      'PROCESSING',
      'SENT',
      'FAILED',
      'RETRYING',
      'DEAD',
      'CANCELLED',
    ],
  })
  @IsOptional()
  @IsEnum(MessageStatus)
  status?: MessageStatus;

  @ApiPropertyOptional({
    description: 'medio de envio de mensaje',
    enum: ['WHATSAPP', 'EMAIL', 'SMTP'],
  })
  @IsOptional()
  @IsEnum(MessageChannel)
  channel?: MessageChannel;

  @ApiPropertyOptional({
    description: 'Mesaje programado desde esta fecha (ISO 8601)',
    example: '2026-05-28T00:00:00.000Z',
  })
  @IsOptional()
  @IsDateString()
  scheduledFrom?: string;

  @ApiPropertyOptional({
    description: 'Mesaje programado hasta esta fecha (ISO 8601)',
    example: '2026-06-28T10:00:00.000Z',
  })
  @IsOptional()
  @IsDateString()
  scheduledTo?: string;

  @ApiPropertyOptional({
    description: 'Buscar por destinatario (GAMIL - WHATSAPP)',
    example: 'example@gmail.com',
  })
  @IsOptional()
  @IsString()
  recipient?: string;

  @ApiPropertyOptional({ description: 'Pagina', default: 1 })
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ description: 'Resultdo por pagina', default: 20 })
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  @Min(20)
  limit?: number = 20;
}
