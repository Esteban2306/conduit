import { Injectable, Logger } from '@nestjs/common';

export interface IntentEvent {
  conversationId: string;
  intent: string;
  handler: string;
  mode: string;
  outcome: string;
  confidence?: number;
  latencyMs?: number;
}

/**
 * Contadores por intención y resultado, y una línea de log por turno
 * clasificado. Sin tokens: ninguna de estas rutas llama a la IA.
 */
@Injectable()
export class IntentMetricsService {
  private readonly logger = new Logger(IntentMetricsService.name);
  private readonly counters = new Map<string, number>();

  record(event: IntentEvent): void {
    const key = `${event.intent}:${event.outcome}`;
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
    this.logger.log(
      `intent=${event.intent} handler=${event.handler} mode=${event.mode} outcome=${event.outcome}` +
        (event.confidence !== undefined
          ? ` confidence=${event.confidence.toFixed(2)}`
          : '') +
        (event.latencyMs !== undefined ? ` ms=${event.latencyMs}` : '') +
        ` conv=${event.conversationId}`,
    );
  }

  count(name: string): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + 1);
  }

  snapshot(): Record<string, number> {
    return Object.fromEntries(this.counters);
  }
}
