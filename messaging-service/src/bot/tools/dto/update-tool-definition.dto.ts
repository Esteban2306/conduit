import { IsBoolean, IsOptional } from 'class-validator';
import { CreateToolDefinitionDto } from './create-tool-definition.dto';
import { PartialType } from '@nestjs/swagger';

export class UpdateToolDefinitionDto extends PartialType(
  CreateToolDefinitionDto,
) {
  @IsOptional()
  @IsBoolean()
  clearAuth?: boolean;
}
