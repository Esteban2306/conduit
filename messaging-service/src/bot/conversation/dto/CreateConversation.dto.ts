import { IsString, IsOptional, IsObject } from 'class-validator';

export class CreateConversationDto {
  @IsString()
  botConfigId: string;

  @IsString()
  phoneNumber: string;

  @IsString()
  tenantId: string;

  @IsOptional()
  @IsObject()
  initialContext?: Record<string, unknown>;
}
