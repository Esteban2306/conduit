import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { WhatsAppCampaignPolicy } from '@prisma/client';

export class UpdateCampaignPolicyDto {
  /** INBOUND_ONLY (recomendado) o ANY (más riesgo de bloqueo). */
  @IsEnum(WhatsAppCampaignPolicy)
  campaignPolicy: WhatsAppCampaignPolicy;

  /** Días hacia atrás en que el contacto debe haber escrito. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(730)
  inboundLookbackDays?: number;
}
