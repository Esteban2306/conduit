import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, Matches } from 'class-validator';

export class CreateTagDto {
  @ApiProperty({
    description: 'Nombre visible del tag',

    example: 'Promoción',
  })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({
    description: 'Slug único del tag (URL-safe)',

    example: 'promocion',
  })
  @IsString()
  @IsNotEmpty()
  @Matches(/^[a-z0-9-]+$/, {
    message: 'slug solo permite minúsculas, números y guiones',
  })
  slug: string;

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
