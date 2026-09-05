import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  Min,
} from 'class-validator';

export class CreateToolDefinitionDto {
  @IsString()
  @Matches(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/)
  name: string;

  @IsString()
  @IsNotEmpty()
  description: string;

  /** JSON Schema for the arguments the model is allowed to send. */
  @IsObject()
  parametersSchema: Record<string, unknown>;

  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  endpointUrl: string;

  @IsOptional()
  @IsIn(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
  httpMethod?: string;

  @IsOptional()
  @IsString()
  authHeaderName?: string;

  /** Stored encrypted and never returned by the API. */
  @IsOptional()
  @IsString()
  authSecret?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsBoolean()
  requiresImageAttachment?: boolean;

  @IsOptional()
  @IsString()
  imageParamName?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(25 * 1024 * 1024)
  maxImageSizeBytes?: number;

  /** Field that Conduit fills with the WhatsApp sender number. */
  @IsOptional()
  @IsString()
  injectPhoneParamName?: string;
}
