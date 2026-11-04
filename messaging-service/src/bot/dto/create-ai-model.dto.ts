import {
  IsString,
  IsEnum,
  IsOptional,
  IsBoolean,
  IsInt,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AiProvider, AiModelTier, AiModelRole } from '@prisma/client';

export class CreateAiModelDto {
  @ApiProperty({ enum: AiProvider, example: 'ANTHROPIC' })
  @IsEnum(AiProvider)
  provider: AiProvider;

  @ApiProperty({ example: 'claude-sonnet-4-20250514' })
  @IsString()
  model: string;

  @ApiProperty({ example: 'sk-ant-...' })
  @IsString()
  apiKey: string;

  @ApiPropertyOptional({ description: 'Solo para provider CUSTOM' })
  @IsOptional()
  @IsString()
  baseUrl?: string;

  @ApiProperty({
    enum: AiModelRole,
    example: 'CONVERSATION',
    description:
      'CONVERSATION = responder mensajes, IMAGE_ANALYSIS = verificar comprobantes, FALLBACK = respaldo automático',
  })
  @IsEnum(AiModelRole)
  role: AiModelRole;

  @ApiProperty({
    enum: AiModelTier,
    example: 'FREE',
    description:
      'FREE activa la cascada automática cuando se agotan los tokens',
  })
  @IsEnum(AiModelTier)
  tier: AiModelTier;

  @ApiProperty({
    example: 1,
    description: '1 = se usa primero, 2 = fallback, 3 = segundo fallback',
  })
  @IsInt()
  @Min(1)
  priority: number;

  @ApiPropertyOptional({
    example: 100000,
    description:
      'Tokens máximos por día (solo para FREE). Si se alcanza, pasa al siguiente',
  })
  @IsOptional()
  @IsInt()
  dailyTokenLimit?: number;

  @ApiPropertyOptional({
    example: 10,
    description: 'Requests máximos por minuto (solo para FREE)',
  })
  @IsOptional()
  @IsInt()
  minuteRequestLimit?: number;
}
