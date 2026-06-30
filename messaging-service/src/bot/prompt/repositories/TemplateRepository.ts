import { Injectable } from '@nestjs/common';
import { BotPromptTemplate, PromptTemplateType } from '@prisma/client';
import { PrismaService } from 'src/shared/prisma.service';

const DEFAULT_TEMPLATES: Record<PromptTemplateType, string> = {
  CONVERSATION: `Eres {{agentName}}, asistente virtual de {{companyName}}.
Idioma: {{language}}. Tono: {{tone}}.
{{#personality}}Personalidad: {{personality}}
{{/personality}}{{#goals}}Objetivos: {{goals}}
{{/goals}}{{#services}}Servicios: {{services}}
{{/services}}{{#businessHours}}Horario: {{businessHours}}
{{/businessHours}}{{#restrictions}}Restricciones: {{restrictions}}
{{/restrictions}}{{#fallbackBehavior}}{{fallbackBehavior}}
{{/fallbackBehavior}}Responde de forma {{responseLength}}. {{emojiInstruction}} {{formatInstruction}} {{confidenceNote}} {{persuasionNote}} {{creativityNote}}`,

  IMAGE_ANALYSIS: `Eres {{agentName}} de {{companyName}}.
Analiza la imagen en contexto del negocio.
{{#restrictions}}{{restrictions}}
{{/restrictions}}Responde SOLO en JSON exacto:
{"valid":boolean,"confidence":"HIGH"|"MEDIUM"|"LOW","details":"descripción breve"}`,

  SUMMARY: `Resume la conversación en máximo 3 oraciones en {{language}}.
Conserva: intención del cliente, datos recolectados, último paso. Sé muy conciso.`,

  SALES: `Eres {{agentName}}, especialista en ventas de {{companyName}}.
Tono: {{tone}}. Objetivo: guiar al cliente hacia la compra.
{{#services}}Ofrecemos: {{services}}
{{/services}}{{#restrictions}}{{restrictions}}{{/restrictions}}`,

  APPOINTMENT: `Eres {{agentName}} de {{companyName}}, gestionas agendamientos.
Recopila: nombre, fecha preferida, servicio deseado.
{{#businessHours}}Disponibilidad: {{businessHours}}
{{/businessHours}}{{#restrictions}}{{restrictions}}{{/restrictions}}`,

  SUPPORT: `Eres {{agentName}}, soporte de {{companyName}}.
Resuelve problemas del cliente de forma clara y empática.
{{#restrictions}}{{restrictions}}{{/restrictions}}`,

  FALLBACK: `Eres {{agentName}} de {{companyName}}.
No puedo ayudarte con eso. ¿Hay algo más en lo que pueda asistirte?`,
};

@Injectable()
export class TemplateRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findActive(
    botConfigId: string,
    type: PromptTemplateType,
  ): Promise<string> {
    const row = await this.prisma.botPromptTemplate.findFirst({
      where: { botConfigId, type, isActive: true },
      orderBy: { version: 'desc' },
      select: { content: true },
    });

    return row?.content ?? DEFAULT_TEMPLATES[type];
  }

  async findAll(botConfigId: string): Promise<BotPromptTemplate[]> {
    return this.prisma.botPromptTemplate.findMany({
      where: { botConfigId },
      orderBy: [{ type: 'asc' }, { version: 'desc' }],
    });
  }

  async upsert(
    botConfigId: string,
    type: PromptTemplateType,
    content: string,
  ): Promise<BotPromptTemplate> {
    await this.prisma.botPromptTemplate.updateMany({
      where: { botConfigId, type },
      data: { isActive: false },
    });

    const last = await this.prisma.botPromptTemplate.findFirst({
      where: { botConfigId, type },
      orderBy: { version: 'desc' },
      select: { version: true },
    });

    return this.prisma.botPromptTemplate.create({
      data: {
        botConfigId,
        type,
        content,
        version: (last?.version ?? 0) + 1,
        isActive: true,
      },
    });
  }

  getDefault(type: PromptTemplateType): string {
    return DEFAULT_TEMPLATES[type];
  }
}
