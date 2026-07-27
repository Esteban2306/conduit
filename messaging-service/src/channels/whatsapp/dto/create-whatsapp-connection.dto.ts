import { ApiProperty } from '@nestjs/swagger';
import { WhatsAppWarmupLevel } from '@prisma/client';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateWhatsAppConnectionDto {
  @ApiProperty({ example: 'uuid-del-bot-config' })
  @IsString()
  botConfigId: string;

  @ApiProperty({ example: 'Ventas' })
  @IsString()
  @MaxLength(120)
  name: string;

  @IsOptional()
  @IsEnum(WhatsAppWarmupLevel)
  warmupLevel?: WhatsAppWarmupLevel;
}
