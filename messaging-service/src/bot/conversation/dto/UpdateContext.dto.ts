import { IsObject, IsOptional, IsString } from 'class-validator';

export class UpdateContextDto {
  @IsOptional()
  @IsObject()
  contextPatch?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  intent?: string;

  @IsOptional()
  @IsString()
  step?: string;
}
