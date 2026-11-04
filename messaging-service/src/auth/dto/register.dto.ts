import { IsEmail, IsString, MinLength } from 'class-validator';

export class RegisterDto {
  @IsString()
  companyName: string;

  @IsString()
  companySlug: string;

  @IsEmail()
  ownerEmail: string;

  @IsString()
  @MinLength(6)
  ownerPassword: string;

  @IsString()
  ownerName: string;
}
