import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class CreateExternalIntegrationDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;
}
