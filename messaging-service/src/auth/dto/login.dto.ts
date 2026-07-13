import { IsEmail, IsString } from 'class-validator';

export class LoginDto {
  @IsString()
  tenantSlug: string;

  @IsEmail()
  email: string;

  @IsString()
  password: string;
}
