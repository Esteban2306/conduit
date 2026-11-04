import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { IsObject, IsOptional, IsString, IsEnum } from 'class-validator';

export class PreviewVariableInput {
  @ApiPropertyOptional({
    description: 'Variable de prueba (clave: valor)',

    example: { nombreCliente: 'Esteban Castañeda', numeroPedido: '12345' },
  })
  @IsObject()
  variables: Record<string, unknown>;
}

export class PreviewTemplateDto {
  @ApiProperty({
    description:
      'Variables de prueba para renderizar la plantilla. ' +
      'Las keys deben coincidir con las variables detectadas en el bodyHandlebars.',

    example: {
      nombreCliente: 'Esteban Castañeda',

      numeroPedido: '12345',

      total: 150000,

      fechaPedido: '2026-06-01',
    },
  })
  @IsObject()
  variables: Record<string, unknown>;

  @ApiPropertyOptional({
    description:
      'Subject alternativo para preview (sobrescribe el del template, solo para EMAIL)',

    example: 'Tu pedido #12345 fue confirmado - Oferta especial',
  })
  @IsString()
  @IsOptional()
  subject?: string;
}
