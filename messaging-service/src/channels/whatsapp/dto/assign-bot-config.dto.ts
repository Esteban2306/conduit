import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

export class AssignBotConfigDto {
  @ApiProperty({ example: 'uuid-del-bot-config' })
  @IsString()
  botConfigId: string;
}
