import { Injectable, Logger } from '@nestjs/common';
import { ConversationService } from './ConversationService';
import { PromptEngine } from '../prompt/PromptEngine';
import { AiOrchestrator } from '../ai/AiOrchestrator';

/**
 * Lo que el resumen debe conservar sí o sí, sin importar la plantilla
 * SUMMARY que tenga configurada el bot: es la memoria de largo plazo de la
 * conversación cuando los mensajes salen de la ventana del historial.
 */
const SUMMARY_GUIDE = `
Actualiza el resumen de una conversación de atención al cliente por WhatsApp.
Devuelve solo el resumen, en texto plano, máximo 8 líneas, sin inventar nada. Debe conservar:
- El objetivo actual del cliente y en qué paso va (por ejemplo: "quiere reagendar su cita del 15/10; ya eligió el 18/10, falta confirmar la hora").
- Los datos ya confirmados: nombre, servicios, fechas, horas, identificadores de reservas o pagos.
- Lo que quedó pendiente o prometido por el negocio.
- Preferencias o restricciones que el cliente mencionó.
Si un objetivo anterior ya se cumplió, indícalo en una línea corta.`.trim();

/**
 * Resumen acumulado: cuando hay suficientes mensajes fuera de la ventana
 * del historial, los integra al resumen previo. Se ejecuta después de
 * responder, sin bloquear al cliente; si falla, se reintenta en el turno
 * siguiente porque `resumenHasta` no avanza.
 */
@Injectable()
export class ConversationSummarizer {
  private readonly logger = new Logger(ConversationSummarizer.name);
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly conversations: ConversationService,
    private readonly promptEngine: PromptEngine,
    private readonly ai: AiOrchestrator,
  ) {}

  async refreshIfNeeded(
    conversationId: string,
    botConfigId: string,
    maxHistoryMessages: number,
  ): Promise<void> {
    if (this.inFlight.has(conversationId)) return;
    this.inFlight.add(conversationId);

    try {
      const batch = await this.conversations.getMessagesToSummarize(
        conversationId,
        maxHistoryMessages,
      );
      if (!batch) return;

      const [conversation, summaryPrompt] = await Promise.all([
        this.conversations.findById(conversationId),
        this.promptEngine.buildSummaryPrompt(botConfigId),
      ]);

      const previous = conversation.summary?.trim() || '(sin resumen previo)';
      const result = await this.ai.generateResponse({
        botConfigId,
        systemPrompt: `${summaryPrompt.systemPrompt}\n\n${SUMMARY_GUIDE}`,
        userMessage: `Resumen anterior:\n${previous}\n\nMensajes nuevos a integrar:\n${batch.lines.join('\n')}`,
        history: [],
        context: {},
        summary: null,
        maxTokens: Math.max(summaryPrompt.maxTokens, 300),
        temperature: 0.2,
      });

      const summary = result.content?.trim();
      if (!summary) return;

      await this.conversations.saveSummary(conversationId, summary, batch.upTo);
      this.logger.debug(
        `Resumen actualizado para ${conversationId} (${batch.lines.length} mensajes integrados)`,
      );
    } catch (error) {
      this.logger.warn(
        `No fue posible actualizar el resumen de ${conversationId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.inFlight.delete(conversationId);
    }
  }
}
