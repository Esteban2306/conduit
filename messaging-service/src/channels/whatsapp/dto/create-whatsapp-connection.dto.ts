import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';

export class CreateWhatsAppConnectionDto {
  @ApiProperty({ example: 'uuid-del-bot-config' })
  @IsString()
  botConfigId: string;

  @ApiProperty({ example: 'Ventas' })
  @IsString()
  @MaxLength(120)
  name: string;
}
