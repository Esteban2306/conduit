import {
  IsString,
  IsBoolean,
  IsInt,
  IsObject,
  IsOptional,
  Min,
  Max,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  STABLE_KEY_MAX_LENGTH,
  STABLE_KEY_MESSAGE,
  STABLE_KEY_PATTERN,
} from 'src/shared/stable-key';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateBotConfigDto {
  @ApiProperty({ example: 'Bot Beauty Studio Ana' })
  @IsString()
  name: string;

  @ApiPropertyOptional({
    example: 'bot-reservas',
    description:
      'Clave estable única por tenant. Si no se envía, se genera a partir del nombre.',
  })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(STABLE_KEY_MAX_LENGTH)
  @Matches(STABLE_KEY_PATTERN, { message: STABLE_KEY_MESSAGE })
  key?: string;

  @ApiProperty({
    example: 'Eres Sofia, asistente virtual de Beauty Studio...',
    description:
      'Prompt completo: personalidad, servicios, reglas de pago, instrucciones de verificación. Todo va aquí.',
  })
  @IsString()
  systemPrompt: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  imageAnalysisEnabled?: boolean;

  @ApiPropertyOptional({ example: 'https://api.beautystudio.com' })
  @IsOptional()
  @IsString()
  clientApiBaseUrl?: string;

  @ApiPropertyOptional({ example: { Authorization: 'Bearer token123' } })
  @IsOptional()
  @IsObject()
  clientApiHeaders?: Record<string, string>;

  @ApiPropertyOptional({
    example: {
      check_availability: {
        method: 'GET',
        path: '/api/slots',
        params: ['date'],
      },
      book_appointment: {
        method: 'POST',
        path: '/api/appointments',
        body: ['client_name', 'slot_id'],
      },
    },
  })
  @IsOptional()
  @IsObject()
  intentEndpoints?: Record<string, unknown>;

  @ApiPropertyOptional({ default: 10 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  maxHistoryMessages?: number;

  @ApiPropertyOptional({
    default: 1440,
    description:
      'Solo procesar mensajes más recientes que este límite en minutos. Default: 1440 (24 horas)',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  maxMessageAgeMinutes?: number;

  @ApiPropertyOptional({
    default: 8,
    description:
      'Segundos que el bot espera antes de responder. Durante este tiempo si el humano actúa, el bot cancela.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(60)
  botResponseDelaySeconds?: number;

  @ApiPropertyOptional({
    default: 10,
    description:
      'Si el dueño respondió en los últimos N minutos, el bot no interfiere',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  humanTakeoverMinutes?: number;

  @ApiPropertyOptional({ default: 60 })
  @IsOptional()
  @IsInt()
  @Min(5)
  conversationTimeoutMinutes?: number;
}
