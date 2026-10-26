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
  context: Record<string, unknown>;
  lastBotMessage: { content: string; at: Date } | null;
  loadTools: () => Promise<ResolvedTool[]>;
  send: (text: string) => Promise<void>;
}

/** El turno sigue a la IA con prompt y herramientas reducidos. */
export interface SlimPlan extends SlimConfig {
  intentKey: string;
  via: 'rules' | 'ai' | 'flow' | 'fallback';
}

export type IntentOutcome =
  | { handled: true }
  | { handled: false; slim?: SlimPlan };

export const ACTIVE_FLOW_KEY = 'activeFlow';
export const OPTED_OUT_KEY = 'optedOutAt';
