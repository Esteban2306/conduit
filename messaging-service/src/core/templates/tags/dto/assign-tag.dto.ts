import { ApiProperty } from '@nestjs/swagger';

import { IsArray, IsString, IsNotEmpty, IsUUID } from 'class-validator';

export class AssignTagDto {
  @ApiProperty({
    description: 'Array de IDs de tags a asignar al template',

    example: ['uuid-tag-1', 'uuid-tag-2'],

    type: [String],
  })
  @IsArray()
  @IsUUID('4', { each: true })
  @IsNotEmpty()
  tagIds: string[];
}
