import {
  IsNotEmptyObject,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class UpsertMappingDto {
  @IsObject()
  @IsNotEmptyObject()
  rules: Record<string, string>;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}
