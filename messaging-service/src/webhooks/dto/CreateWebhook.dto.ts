import { ArrayMinSize, IsArray, IsString, IsUrl } from 'class-validator';

export class CreateWebhookDto {
  @IsUrl({}, { message: 'url debe ser una URL válida' })
  url: string;

  @IsArray()
  @ArrayMinSize(1, { message: 'Debes especificar al menos un evento' })
  @IsString({ each: true })
  events: string[];
}
