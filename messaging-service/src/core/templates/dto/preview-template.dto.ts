import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsObject, IsOptional, IsString } from 'class-validator';

export class PreviewTemplateDto {
  @ApiProperty({
    description: 'Variables de prueba para renderizar la plantilla.',
    example: {
      nombreCliente: 'Esteban Castaneda',
      numeroPedido: '12345',
      total: 150000,
    },
  })
  @IsObject()
  variables: Record<string, unknown>;

  @ApiPropertyOptional({
    description: 'Subject alternativo para preview (solo email)',
    example: 'Tu pedido #12345 fue confirmado',
  })
  @IsString()
  @IsOptional()
  subject?: string;
}
