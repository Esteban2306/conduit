import { ApiPropertyOptional } from '@nestjs/swagger';

import { IsOptional, IsString, IsEnum, IsInt, Min, Max } from 'class-validator';

import { Type } from 'class-transformer';

import { MessageChannel } from '@prisma/client';

export class FilterTemplateDto {
  @ApiPropertyOptional({
    description: 'Filtrar por canal',

    enum: MessageChannel,

    example: 'EMAIL',
  })
  @IsEnum(MessageChannel)
  @IsOptional()
  channel?: MessageChannel;

  @ApiPropertyOptional({
    description: 'Filtrar por ID de tag',

    example: 'uuid-del-tag',
  })
  @IsString()
  @IsOptional()
  tagId?: string;

  @ApiPropertyOptional({
    description: 'Búsqueda en nombre y descripción',

    example: 'pedido',
  })
  @IsString()
  @IsOptional()
  search?: string;

  @ApiPropertyOptional({ example: 1, default: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  page?: number = 1;

  @ApiPropertyOptional({ example: 20, default: 20 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  limit?: number = 20;
}
