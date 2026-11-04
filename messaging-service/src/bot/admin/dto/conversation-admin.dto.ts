import {
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class PauseConversationDto {
  @IsInt()
  @Min(1)
  @Max(7 * 24 * 60)
  minutes: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}

export class HumanReplyDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(4000)
  text: string;
}

export const ESCALATION_TRIGGERS = [
  'TECHNICAL_ERROR',
  'BUSINESS_ERROR',
] as const;

export class CreateEscalationContactDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  label: string;

  /** Formato internacional, con o sin "+". */
  @IsString()
  @Matches(/^\+?[1-9]\d{9,14}$/)
  phoneNumber: string;

  @IsOptional()
  @IsUUID()
  connectionId?: string;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsIn(ESCALATION_TRIGGERS, { each: true })
  notifyOn?: (typeof ESCALATION_TRIGGERS)[number][];
}
