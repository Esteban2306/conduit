import { IsBoolean, IsOptional } from 'class-validator';
import { CreateToolDefinitionDto } from './create-tool-definition.dto';

export class UpdateToolDefinitionDto extends CreateToolDefinitionDto {
  @IsOptional()
  @IsBoolean()
  clearAuth?: boolean;
}
