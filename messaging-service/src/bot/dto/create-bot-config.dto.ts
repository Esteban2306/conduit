import {
  IsString,
  IsBoolean,
  IsInt,
  IsObject,
  IsOptional,
  Min,
  Max,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateBotConfigDto {
  @ApiProperty({ example: 'Bot Beauty Studio Ana' })
  @IsString()
  name: string;

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

  @ApiPropertyOptional({ default: 60 })
  @IsOptional()
  @IsInt()
  @Min(5)
  conversationTimeoutMinutes?: number;
}
