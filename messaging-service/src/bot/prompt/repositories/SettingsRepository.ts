import { Injectable } from '@nestjs/common';
import { BotAiSettings } from '@prisma/client';
import { PrismaService } from 'src/shared/prisma.service';

export const SETTINGS_DEFAULTS = {
  agentName: 'Asistente',
  companyName: 'la empresa',
  language: 'es',
  tone: 'profesional y amable',
  personality: null,
  companyServices: null,
  businessHours: null,
  restrictions: null,
  greeting: null,
  farewell: null,
  responseLength: 'MEDIUM',
  emojiLevel: 'LOW',
  allowMarkdown: false,
  temperature: 0.7,
  maxTokensConversation: 400,
  maxTokensImage: 200,
  maxTokensSummary: 300,
};

@Injectable()
export class SettingsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByBot(botConfigId: string): Promise<BotAiSettings | null> {
    return this.prisma.botAiSettings.findUnique({ where: { botConfigId } });
  }

  async upsert(
    botConfigId: string,
    data: Partial<
      Omit<BotAiSettings, 'id' | 'botConfigId' | 'createdAt' | 'updatedAt'>
    >,
  ): Promise<BotAiSettings> {
    return this.prisma.botAiSettings.upsert({
      where: { botConfigId },
      create: { botConfigId, ...data } as any,
      update: data,
    });
  }
}
