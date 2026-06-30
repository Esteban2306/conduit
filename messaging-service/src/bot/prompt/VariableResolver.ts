import { Injectable } from '@nestjs/common';
import { BotAiSettings } from '@prisma/client';

export interface ResolvedVariables {
  agentName: string;
  companyName: string;
  language: string;
  tone: string;
  personality: string;
  goals: string;
  services: string;
  businessHours: string;
  restrictions: string;
  greeting: string;
  farewell: string;
  fallbackBehavior: string;
  responseLength: string;
  emojiInstruction: string;
  formatInstruction: string;
  creativityNote: string;
  confidenceNote: string;
  persuasionNote: string;
  today: string;
}

const DEFAULTS = {
  agentName: 'Asistente',
  language: 'es',
  tone: 'profesional y amable',
  responseLength: 'MEDIUM',
  emojiLevel: 'LOW',
};

@Injectable()
export class VariableResolver {
  resolve(settings: BotAiSettings | null): ResolvedVariables {
    const s = settings;

    return {
      agentName: s?.agentName ?? 'Asistente',
      companyName: s?.companyName ?? 'la empresa',
      language: s?.language ?? 'es',
      tone: s?.tone ?? 'profesional y amable',
      personality: s?.personality ?? '',
      goals: s?.goals ?? '',
      services: s?.companyServices ?? '',
      businessHours: s?.businessHours ?? '',
      restrictions: s?.restrictions ?? '',
      greeting: s?.greeting ?? '',
      farewell: s?.farewell ?? '',
      fallbackBehavior:
        s?.fallbackBehavior ??
        'Si no tengo la información, lo digo claramente sin inventar.',
      responseLength: this.mapVerbosity(s?.verbosity ?? 'MEDIUM'),
      emojiInstruction: this.mapEmoji(s?.emojiLevel ?? 'LOW'),
      formatInstruction: this.mapFormat(
        s?.responseFormat ?? 'PROSE',
        s?.allowMarkdown ?? false,
        s?.allowMarkdown ?? false,
      ),
      creativityNote: this.mapCreativity(s?.creativity ?? 0.7),
      confidenceNote: this.mapConfidence(s?.confidence ?? 'ASSERTIVE'),
      persuasionNote: this.mapPersuasion(s?.persuasion ?? 'LOW'),
      today: new Date().toLocaleDateString('es-CO', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      }),
    };
  }

  private mapLength(value: string): string {
    const map: Record<string, string> = {
      SHORT: 'muy breve (1-2 oraciones)',
      MEDIUM: 'concisa (2-4 oraciones)',
      LONG: 'detallada (varios párrafos si es necesario)',
    };
    return map[value] ?? 'concisa (2-4 oraciones)';
  }

  private mapVerbosity(v: string): string {
    const map: Record<string, string> = {
      MINIMAL: 'en una sola oración',
      SHORT: 'muy breve (1-2 oraciones)',
      MEDIUM: 'concisa (2-4 oraciones)',
      LONG: 'detallada cuando sea necesario',
    };
    return map[v] ?? 'concisa (2-4 oraciones)';
  }

  private mapFormat(
    format: string,
    markdown: boolean,
    tables: boolean,
  ): string {
    const parts: string[] = [];
    if (format === 'BULLETS')
      parts.push('Usa listas con viñetas cuando sea útil.');
    if (format === 'MIXED')
      parts.push('Mezcla prosa y listas según el contenido.');
    if (!markdown) parts.push('No uses formato Markdown (sin **, ##, etc).');
    if (markdown && tables)
      parts.push('Puedes usar tablas Markdown cuando ayuden.');
    return parts.join(' ');
  }

  private mapCreativity(v: number): string {
    if (v <= 0.3)
      return 'Sé muy preciso y literal, sin interpretaciones libres.';
    if (v <= 0.6)
      return 'Sé directo pero puedes adaptar el lenguaje naturalmente.';
    return '';
  }

  private mapConfidence(v: string): string {
    const map: Record<string, string> = {
      ASSERTIVE: 'Habla con seguridad y certeza.',
      NEUTRAL: '',
      HUMBLE: 'Si no estás seguro de algo, exprésalo con cautela.',
    };
    return map[v] ?? '';
  }

  private mapPersuasion(v: string): string {
    const map: Record<string, string> = {
      NONE: '',
      LOW: 'Si es natural, destaca los beneficios del producto o servicio.',
      MEDIUM: 'Guía activamente al cliente hacia la acción.',
      HIGH: 'Usa técnicas de venta consultiva para cerrar.',
    };
    return map[v] ?? '';
  }

  private mapEmoji(value: string): string {
    const map: Record<string, string> = {
      NONE: 'No uses emojis.',
      LOW: 'Usa emojis con moderación.',
      MEDIUM: 'Usa emojis para dar expresividad.',
      HIGH: 'Usa emojis frecuentemente.',
    };
    return map[value] ?? '';
  }
}
