import { Injectable } from '@nestjs/common';
import { ConversationContext } from '../conversation/interfaces/ConversationContext';
import { HistoryMessage } from '../conversation/interfaces/ConversationHistory';

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
      parts.push(`Resumen: ${summary.trim()}`);
    }

    const contextLine = this.buildContextLine(context);
    if (contextLine) {
      parts.push(`Contexto: ${contextLine}`);
    }

    const block = parts.length > 0 ? parts.join('\n') : null;

    const tokenEstimate = block ? Math.ceil(block.length / 4) : 0;

    return { block, tokenEstimate };
  }

  buildHistoryNarrative(history: HistoryMessage[]): string | null {
    if (history.length === 0) return null;

    const recent = history.slice(-3);
    const lines: string[] = [];

    for (const msg of recent) {
      const role = msg.role === 'user' ? 'Cliente' : 'Bot';
      const content = msg.content.slice(0, 100).replace(/\n/g, ' ');
      lines.push(`${role}: ${content}`);
    }

    return `Conversación reciente:\n${lines.join('\n')}`;
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
