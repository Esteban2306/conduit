import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { InlineTemplateDto } from './inline-template.dto';
import { HasTemplateSource } from '../validators/has-template-source.validator';

export class TemplateRefDto {
  @ApiPropertyOptional({
    example: '3affc54f-8c6a-4613-a61f-8e2301ca7b5b',
    description: 'UUID de un template ya guardado en la plataforma',
  })
  @IsUUID('4', { message: 'template.id debe ser un UUID v4 válido' })
  @IsOptional()
  @HasTemplateSource({
    message:
      'Debes proveer template.id o template.inline, no pueden estar ambos vacíos',
  })
  id?: string;

  @ApiPropertyOptional({
    type: () => InlineTemplateDto,
    description: 'Template ad-hoc, alternativa a usar un template.id guardado',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => InlineTemplateDto)
  inline?: InlineTemplateDto;
}
