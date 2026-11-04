import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class InlineTemplateDto {
  @ApiPropertyOptional({ example: 'Tu código de verificación' })
  @IsString()
  @IsOptional()
  subject?: string;

  @ApiProperty({
    example:
      'Hola {{name}}, tu código es {{code}}. Vence en {{expiryMinutes}} min.',
    description: 'Cuerpo del mensaje en formato Handlebars',
  })
  @IsString()
  @IsNotEmpty({ message: 'inline.body no puede estar vacío' })
  body: string;
}
