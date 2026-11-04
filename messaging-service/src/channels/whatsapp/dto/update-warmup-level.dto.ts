import { IsEnum } from 'class-validator';
import { WhatsAppWarmupLevel } from '@prisma/client';

export class UpdateWarmupLevelDto {
  @IsEnum(WhatsAppWarmupLevel)
  warmupLevel: WhatsAppWarmupLevel;
}
