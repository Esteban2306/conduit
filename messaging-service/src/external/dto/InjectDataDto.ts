import { SourceVariable } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNotEmptyObject,
  IsObject,
  IsOptional,
  IsPositive,
} from 'class-validator';

export class InjectDataDto {
  @IsObject()
  @IsNotEmptyObject()
  variables: Record<string, string>;

  @IsEnum(SourceVariable)
  source: SourceVariable;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  ttlSeconds?: number;
}
