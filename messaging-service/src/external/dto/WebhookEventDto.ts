import { IsObject, IsOptional, IsString } from 'class-validator';

export class WebhookEventDto {
  @IsString()
  eventType: string;

  @IsObject()
  payload: Record<string, any>;

  @IsString()
  @IsOptional()
  signature?: string;
}
