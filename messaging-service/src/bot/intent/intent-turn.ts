import type { ResolvedTool } from '../tools/ToolDefinitionService';
import type { SlimConfig } from './intent-types';

export interface IntentTurn {
  tenantId: string;
  botConfigId: string;
  conversationId: string;
  connectionId: string;
  phoneNumber: string;
  text: string;
  hasImage: boolean;
  turnId: string;
  /** Ids de los mensajes entrantes sin responder (para ignorarlos si el turno se resuelve en silencio). */
  pendingIds?: string[];
  context: Record<string, unknown>;
  lastBotMessage: { content: string; at: Date } | null;
  loadTools: () => Promise<ResolvedTool[]>;
  send: (text: string) => Promise<void>;
}

/** El turno sigue a la IA con prompt y herramientas reducidos. */
export interface SlimPlan extends SlimConfig {
  intentKey: string;
  /** confirmHint resuelto para este turno (la clienta acaba de confirmar). */
  hint?: string;
  via: 'rules' | 'ai' | 'flow' | 'fallback';
}

export type IntentOutcome =
  | { handled: true }
  | { handled: false; slim?: SlimPlan };

export const ACTIVE_FLOW_KEY = 'activeFlow';
export const OPTED_OUT_KEY = 'optedOutAt';

export const TASK_DONE_KEY = 'taskDoneAt';
/** Tras terminar el agendamiento, el relleno (gracias, ok…) no recibe respuesta durante este tiempo. */
export const TASK_DONE_QUIET_MS = 30 * 60 * 1000;

export function isTaskDone(
  context: Record<string, unknown> | null | undefined,
  now: number = Date.now(),
): boolean {
  const at = context?.[TASK_DONE_KEY];
  return (
    typeof at === 'string' && now - new Date(at).getTime() < TASK_DONE_QUIET_MS
  );
}
