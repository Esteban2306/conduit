import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { MessageChannel } from '@prisma/client';

export class MessageRecipientDto {
  @ApiProperty({
    enum: MessageChannel,
    example: 'WHATSAPP',
    description: 'Canal por el que se enviará el mensaje',
  })
  @IsEnum(MessageChannel, {
    message: `channel debe ser uno de: ${Object.values(MessageChannel).join(', ')}`,
  })
  channel: MessageChannel;

  @ApiProperty({
    example: '573108525522',
    description:
      'Número de WhatsApp (sin "+") o email del destinatario, según el channel',
  })
  @IsString()
  @IsNotEmpty({ message: 'address no puede estar vacío' })
  address: string;

  @ApiPropertyOptional({ example: 'Luz Marina' })
  @IsString()
  @IsOptional()
  name?: string;
}
