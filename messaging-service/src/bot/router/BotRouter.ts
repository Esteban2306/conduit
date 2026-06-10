import { Injectable } from '@nestjs/common';
import { BotConfigService } from '../config/BotConfigService';

export interface IncomingMessageDto {
  phoneNumber: string;
  content: string;
  hasImage: boolean;
  imageUrl?: string;
}

@Injectable()
export class botRouter {
  constructor(private readonly botConfigService: BotConfigService) {}
}
