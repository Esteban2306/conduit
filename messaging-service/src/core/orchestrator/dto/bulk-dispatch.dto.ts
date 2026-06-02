import { IsString, IsArray, IsOptional, IsObject, ValidateNested, IsUUID } from 'class-validator'
import { Type } from 'class-transformer'
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'

class RecipientDto {
  @ApiProperty({ example: 'juan@gmail.com' })
  @IsString()
  address: string

  @ApiPropertyOptional({ example: 'Juan Pérez' })
  @IsString()
  @IsOptional()
  name?: string

  @ApiPropertyOptional({
    description: 'Variables específicas para este destinatario',
    example: { nombre: 'Juan', pedido: '12345' }
  })
  @IsObject()
  @IsOptional()
  variables?: Record<string, unknown>
}

class BulkOptionsDto {
  @ApiPropertyOptional({ enum: ['low', 'normal', 'high'], default: 'normal' })
  @IsString()
  @IsOptional()
  priority?: 'low' | 'normal' | 'high'

  @ApiPropertyOptional({ example: '2026-05-29T09:00:00.000Z' })
  @IsString()
  @IsOptional()
  scheduledAt?: string
}

export class BulkDispatchDto {
  @ApiProperty({ description: 'UUID del template a usar para todos los destinatarios' })
  @IsUUID()
  templateId: string

  @ApiProperty({
    description: 'Lista de destinatarios con sus variables individuales',
    type: [RecipientDto]
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RecipientDto)
  recipients: RecipientDto[]

  @ApiPropertyOptional()
  @IsOptional()
  @ValidateNested()
  @Type(() => BulkOptionsDto)
  options?: BulkOptionsDto
}