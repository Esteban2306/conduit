import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmptyObject,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

class WebhookActionDto {
  @IsBoolean()
  enabled: boolean;

  @IsString()
  connectionId: string;

  @IsString()
  recipientField: string;

  @IsOptional()
  @IsString()
  templateId?: string;

  @IsOptional()
  @IsString()
  inlineBody?: string;

  @IsOptional()
  @IsString()
  scheduleField?: string;

  @IsOptional()
  @IsInt()
  scheduleOffsetMinutes?: number;

  @IsOptional()
  @IsEnum(['low', 'normal', 'high'])
  priority?: 'low' | 'normal' | 'high';
}

export class UpsertMappingDto {
  @IsObject()
  @IsNotEmptyObject()
  rules: Record<string, string>;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => WebhookActionDto)
  action?: WebhookActionDto;
}
