import { Injectable } from '@nestjs/common';
import { ConversationContext } from '../conversation/interfaces/ConversationContext';

export interface BuiltContext {
  block: string | null;
  tokenEstimate: number;
}

const EXCLUDED = new Set([
  'retryCount',
  'imageVerified',
  'lastImageAnalysis',
  'processingAt',
  'lockedBy',
  'lastImageDetails',
  'memoriaAcciones',
  'resumenHasta',
  'botPausedUntil',
  'botPauseReason',
  'aiFallbackAt',
  'abuseNoticeAt',
]);

const PRIORITY_KEYS = [
  'currentStep',
  'lastIntent',
  'clientName',
  'clientEmail',
  'orderStatus',
  'appointmentDate',
  'pendingAction',
  'collectedData',
];

@Injectable()
export class ContextBuilder {
  build(context: ConversationContext, summary: string | null): BuiltContext {
    const parts: string[] = [];

    if (summary?.trim()) {
      parts.push(
        `Resumen de la conversación anterior (objetivo y acuerdos):\n${summary.trim()}`,
      );
    }

    const actions = this.buildActionMemory(context);
    if (actions) parts.push(actions);

    const contextLine = this.buildContextLine(context);
    if (contextLine) {
      parts.push(`Contexto: ${contextLine}`);
    }

    const block = parts.length > 0 ? parts.join('\n') : null;

    const tokenEstimate = block ? Math.ceil(block.length / 4) : 0;

    return { block, tokenEstimate };
  }

  /**
   * Resultados reales de las herramientas ya usadas en esta conversación
   * (horarios consultados, reserva creada con su id, etc.). Evita que el
   * modelo vuelva a preguntar o invente datos que ya obtuvo.
   */
  private buildActionMemory(context: ConversationContext): string | null {
    const entries = Array.isArray(context.memoriaAcciones)
      ? (context.memoriaAcciones as Array<Record<string, string>>)
      : [];
    if (entries.length === 0) return null;

    const lines = entries.map(
      (e) =>
        `- [${e.en}] ${e.herramienta}(${e.parametros}) → ${e.estado}: ${e.resultado}`,
    );
    return `Acciones ya realizadas en esta conversación (resultados reales, del más antiguo al más reciente):\n${lines.join('\n')}`;
  }

  private buildContextLine(context: ConversationContext): string | null {
    const lines: string[] = [];
    const prioritySet = new Set(PRIORITY_KEYS);

    for (const key of PRIORITY_KEYS) {
      const v = (context as any)[key];
      if (v != null && v !== '') lines.push(`${key}=${this.compact(v)}`);
    }

    for (const [k, v] of Object.entries(context)) {
      if (EXCLUDED.has(k) || prioritySet.has(k) || v == null || v === '')
        continue;
      lines.push(`${k}=${this.compact(v)}`);
    }

    if (lines.length === 0) return null;

    const joined = lines.join(', ');
    return joined.length > 600 ? joined.slice(0, 600) + '…' : joined;
  }

  private compact(value: unknown): string {
    if (typeof value === 'string') return value.slice(0, 80);
    if (typeof value === 'number' || typeof value === 'boolean')
      return String(value);
    if (Array.isArray(value))
      return value
        .slice(0, 3)
        .map((v) => this.compact(v))
        .join('|');
    if (typeof value === 'object') {
      return Object.entries(value as Record<string, unknown>)
        .slice(0, 3)
        .map(([k, v]) => `${k}:${this.compact(v)}`)
        .join(';');
    }
    return String(value).slice(0, 80);
  }
}
