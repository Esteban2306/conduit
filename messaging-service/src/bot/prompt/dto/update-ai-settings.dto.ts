import { EmojiLevel, ResponseLength } from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * Personalidad y límites del bot. Antes el cuerpo llegaba sin validar a la
 * base (`any`): se podía reasignar `botConfigId` o fijar tokens sin tope.
 * La whitelist global rechaza cualquier campo que no esté aquí.
 */
export class UpdateAiSettingsDto {
  @IsOptional() @IsString() @MaxLength(60) agentName?: string;
  @IsOptional() @IsString() @MaxLength(10) language?: string;
  @IsOptional() @IsString() @MaxLength(60) tone?: string;
  @IsOptional() @IsString() @MaxLength(2000) personality?: string;
  @IsOptional() @IsString() @MaxLength(2000) goals?: string;
  @IsOptional() @IsString() @MaxLength(20) verbosity?: string;
  @IsOptional() @IsString() @MaxLength(20) responseFormat?: string;
  @IsOptional() @IsNumber() @Min(0) @Max(1) creativity?: number;
  @IsOptional() @IsString() @MaxLength(20) confidence?: string;
  @IsOptional() @IsString() @MaxLength(20) persuasion?: string;
  @IsOptional() @IsString() @MaxLength(500) fallbackBehavior?: string;
  @IsOptional() @IsEnum(ResponseLength) responseLength?: ResponseLength;
  @IsOptional() @IsEnum(EmojiLevel) emojiLevel?: EmojiLevel;
  @IsOptional() @IsBoolean() allowMarkdown?: boolean;
  @IsOptional() @IsString() @MaxLength(120) companyName?: string;
  @IsOptional() @IsString() @MaxLength(4000) companyServices?: string;
  @IsOptional() @IsString() @MaxLength(500) businessHours?: string;
  @IsOptional() @IsString() @MaxLength(500) greeting?: string;
  @IsOptional() @IsString() @MaxLength(500) farewell?: string;
  @IsOptional() @IsString() @MaxLength(4000) restrictions?: string;
  @IsOptional() @IsNumber() @Min(0) @Max(1.5) temperature?: number;
  @IsOptional() @IsInt() @Min(50) @Max(1500) maxTokensConversation?: number;
  @IsOptional() @IsInt() @Min(50) @Max(1000) maxTokensImage?: number;
  @IsOptional() @IsInt() @Min(50) @Max(1000) maxTokensSummary?: number;
}
