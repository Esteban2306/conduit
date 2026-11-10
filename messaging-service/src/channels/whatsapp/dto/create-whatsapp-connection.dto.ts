import { ApiProperty } from '@nestjs/swagger';
import { WhatsAppWarmupLevel } from '@prisma/client';
import {
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  STABLE_KEY_MAX_LENGTH,
  STABLE_KEY_MESSAGE,
  STABLE_KEY_PATTERN,
} from 'src/shared/stable-key';

export class CreateWhatsAppConnectionDto {
  @ApiProperty({ example: 'Ventas' })
  @IsString()
  @MaxLength(120)
  name: string;

  @ApiProperty({
    required: false,
    example: 'linea-ventas',
    description:
      'Clave estable única por tenant. Si no se envía, se genera a partir del nombre.',
  })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(STABLE_KEY_MAX_LENGTH)
  @Matches(STABLE_KEY_PATTERN, { message: STABLE_KEY_MESSAGE })
  key?: string;

  @ApiProperty({ example: 'uuid-del-bot-config' })
  @IsString()
  @IsOptional()
  botConfigId?: string;

  @IsOptional()
  @IsEnum(WhatsAppWarmupLevel)
  warmupLevel?: WhatsAppWarmupLevel;
}
