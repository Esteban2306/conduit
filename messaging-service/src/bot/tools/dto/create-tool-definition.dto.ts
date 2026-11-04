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

  /**
   * Campo que Conduit llena con el teléfono verificado del chat. Admite
   * rutas con punto para campos anidados (p. ej. "client.phone"). El
   * modelo no ve ese campo, así que no puede suplantar a otro cliente.
   */
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/)
  injectPhoneParamName?: string;

  /** Si la llamada sale bien, pausa el bot en la conversación estos minutos. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(7 * 24 * 60)
  pausesBotMinutes?: number;
}
