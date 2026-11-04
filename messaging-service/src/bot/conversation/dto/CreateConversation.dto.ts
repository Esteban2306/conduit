import { IsString, IsOptional, IsObject } from 'class-validator';

export class CreateConversationDto {
  @IsString()
  tenantId: string;

  @IsString()
  botConfigId: string;

  @IsString()
  phoneNumber: string;

  @IsString()
  @IsOptional()
  connectionId?: string;

  @IsOptional()
  @IsObject()
  initialContext?: Record<string, unknown>;
}
