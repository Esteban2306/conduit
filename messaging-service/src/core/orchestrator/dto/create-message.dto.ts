import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsObject, IsOptional, IsUUID, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { MessageRecipientDto } from './Message-recipient.dto';
import { TemplateRefDto } from './template-ref.dto';
import { MessageOptionsDto } from './message-options.dto';

export class CreateMessageDto {
  @ApiProperty({ type: () => MessageRecipientDto })
  @ValidateNested()
  @Type(() => MessageRecipientDto)
  recipient: MessageRecipientDto;

  @ApiProperty({ type: () => TemplateRefDto })
  @ValidateNested()
  @Type(() => TemplateRefDto)
  template: TemplateRefDto;

  @ApiPropertyOptional({
    example: 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e',
    description:
      'UUID de la WhatsAppConnection a usar. Si se omite, el orchestrator elige la conexión activa del bot.',
  })
  @IsUUID('4', { message: 'connectionId debe ser un UUID v4 válido' })
  @IsOptional()
  connectionId?: string;

  @ApiProperty({
    example: { name: 'Luz Marina', code: '4829', expiryMinutes: 15 },
    description: 'Variables para interpolar en el template (Handlebars)',
  })
  @IsObject()
  variables: Record<string, unknown>;

  @ApiPropertyOptional({ type: () => MessageOptionsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => MessageOptionsDto)
  options?: MessageOptionsDto;

  @ApiPropertyOptional({
    example: { source: 'crm-integration' },
    description:
      'Metadata libre, no se interpola ni se valida su estructura interna',
  })
  @IsObject()
  @IsOptional()
  meta?: Record<string, unknown>;
}
