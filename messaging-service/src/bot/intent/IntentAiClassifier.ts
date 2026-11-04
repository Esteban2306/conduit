import { Injectable, Logger } from '@nestjs/common';
import { AiOrchestrator } from '../ai/AiOrchestrator';
import { IntentRecord } from './intent-types';

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const CACHE_MAX = 1000;
const PER_CHAT_LIMIT = 3;
const PER_CHAT_WINDOW_MS = 60 * 60 * 1000;
export const AI_CLASSIFIER_MAX_TOKENS = 12;
export const AI_CLASSIFIER_MAX_WORDS = 30;

const SYSTEM = `Clasificas el mensaje de un cliente de un negocio en UNA intención. Responde SOLO con la clave exacta de la lista, o "ninguna".
Responde "ninguna" si el mensaje mezcla varios temas, si no encaja con claridad en una sola intención, si solo contesta una pregunta anterior del negocio sin pedir algo nuevo, o si tienes dudas.`;

/**
 * Paso 2 del despachador: cuando las reglas no deciden, una llamada mínima
 * (sin herramientas ni razonamiento, ~10 tokens de salida, salida restringida
 * a las claves de la lista) elige entre las intenciones que el negocio marcó
 * como clasificables. Cualquier respuesta fuera de la lista cuenta como
 * "ninguna" y el turno sigue a la IA completa.
 */
@Injectable()
export class IntentAiClassifier {
  private readonly logger = new Logger(IntentAiClassifier.name);
  private readonly cache = new Map<
    string,
    { key: string | null; at: number }
  >();
  private readonly perChat = new Map<string, number[]>();

  constructor(private readonly ai: AiOrchestrator) {}

  async classify(
    botConfigId: string,
    conversationId: string,
    text: string,
    normalized: string,
    candidates: IntentRecord[],
    lastBotMessage: string | null,
  ): Promise<{ key: string | null; cached: boolean } | null> {
    if (candidates.length === 0) return null;

    const signature = `${botConfigId}|${candidates.map((c) => c.key + c.version).join(',')}|${normalized}`;
    const hit = this.cache.get(signature);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      return { key: hit.key, cached: true };
    }
    if (!this.allowForChat(conversationId)) return null;

    const list = candidates
      .map((c) => `- ${c.key}: ${c.description || c.name}`)
      .join('\n');
    const context = lastBotMessage
      ? `Último mensaje del negocio: "${lastBotMessage.slice(0, 150)}"\n`
      : '';

    let content: string;
    try {
      const result = await this.ai.classify({
        botConfigId,
        systemPrompt: `${SYSTEM}\nIntenciones:\n${list}`,
        userMessage: `${context}Mensaje del cliente: "${text.slice(0, 300)}"`,
        maxTokens: AI_CLASSIFIER_MAX_TOKENS,
      });
      content = result.content;
    } catch (error) {
      this.logger.warn(
        `Clasificador de IA no disponible; el turno sigue a la IA completa: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }

    const answer = content
      .toLowerCase()
      .split('\n')[0]
      .replace(/[^a-z0-9_.-]/g, '')
      .replace(/^[._-]+|[._-]+$/g, '')
      .trim();
    const key = candidates.find((c) => c.key === answer)?.key ?? null;
    this.remember(signature, key);
    return { key, cached: false };
  }

  private allowForChat(conversationId: string): boolean {
    const now = Date.now();
    const recent = (this.perChat.get(conversationId) ?? []).filter(
      (at) => now - at < PER_CHAT_WINDOW_MS,
    );
    if (recent.length >= PER_CHAT_LIMIT) {
      this.perChat.set(conversationId, recent);
      return false;
    }
    recent.push(now);
    this.perChat.set(conversationId, recent);
    return true;
  }

  private remember(signature: string, key: string | null): void {
    if (this.cache.size >= CACHE_MAX) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(signature, { key, at: Date.now() });
  }
}
