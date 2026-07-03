import { SourceVariable } from '@prisma/client';
import { IsEnum, IsInt, IsObject, IsOptional } from 'class-validator';

export class InjectDataDto {
  @IsObject()
  variables: Record<string, string>;

  @IsInt()
  @IsOptional()
  ttlSeconds?: number;

  @IsEnum(SourceVariable)
  @IsOptional()
  source?: SourceVariable;
}
