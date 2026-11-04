import { ApiPropertyOptional } from '@nestjs/swagger';

import { IsString, IsOptional, Matches } from 'class-validator';

export class UpdateTagDto {
  @ApiPropertyOptional({
    description: 'Nombre visible del tag',

    example: 'Promoción Flash',
  })
  @IsString()
  @IsOptional()
  name?: string;

  @ApiPropertyOptional({
    description: 'Slug único del tag (URL-safe)',

    example: 'promocion-flash',
  })
  @IsString()
  @IsOptional()
  @Matches(/^[a-z0-9-]+$/, {
    message: 'slug solo permite minúsculas, números y guiones',
  })
  slug?: string;

  @ApiPropertyOptional({
    description: 'Color hexadecimal del tag (para UI)',

    example: '#FF5733',
  })
  @IsString()
  @IsOptional()
  @Matches(/^#[0-9A-Fa-f]{6}$/, {
    message: 'color debe ser un hex válido tipo #FF5733',
  })
  color?: string;
}
