import type { RenderSpec } from './render-spec';
import type { IntentSchedule } from './schedule';

export type HandlerKind = 'TEMPLATE' | 'TOOL_DIRECT' | 'HANDOFF' | 'LLM_SLIM';
export type IntentModeValue = 'OFF' | 'SHADOW' | 'ACTIVE';

export interface SlimConfig {
  /** Instrucciones de esta intención; admite las variables del prompt ({{agentName}}…). */
  prompt: string;
  /** Únicas herramientas que ve el modelo en este manejador. */
  tools: string[];
  maxTokens?: number;
  includeKnowledge?: boolean;
  /** Minutos que el flujo sigue en este manejador sin reclasificar (por defecto 30). */
  flowTtlMinutes?: number;
  /** Si alguna de estas herramientas tiene éxito, el flujo termina. */
  endsOnTools?: string[];
}

export interface IntentConfig {
  tool?: string;
  /** Valores literales o `$entity` (lo capturado por el grupo `entity` del patrón) / `$text`. */
  params?: Record<string, string>;
  render?: RenderSpec;
  cache?: { scope: 'bot' | 'contact'; seconds: number };
  identityOptional?: boolean;
  /** Si el manejador no puede responder, el turno pasa a esta otra intención (p. ej. una LLM_SLIM). */
  fallbackTo?: string;
  reason?: string;
  pauseMinutes?: number;
  notifyTeam?: boolean;
  slim?: SlimConfig;
  /** Marca la intención que aporta el saludo (variantes prefix_<rama>) para el primer contacto. */
  greetingSource?: boolean;
  /** En el primer mensaje del bot a la clienta, la respuesta lleva antes el saludo de la intención greetingSource. */
  greetFirstContact?: boolean;
}

export interface IntentRecord {
  id: string;
  key: string;
  name: string;
  description: string;
  handler: HandlerKind;
  mode: IntentModeValue;
  priority: number;
  patterns: string[];
  denyPatterns: string[];
  maxTokens: number;
  respectsOpenFlow: boolean;
  allowsQuestion: boolean;
  negationOk: boolean;
  fixedConfidence: number | null;
  aiClassifiable: boolean;
  config: IntentConfig;
  variants: Record<string, string[]>;
  cooldownSeconds: number;
  schedule: IntentSchedule | null;
  notes: string | null;
  version: number;
}

/** Prefijo reservado de las reglas duras: su texto se configura aquí, la detección vive en el motor. */
export const RULE_KEY_PREFIX = 'rule.';
export const RULE_KEYS = [
  'rule.opt_out',
  'rule.opt_in',
  'rule.abuse',
  'rule.spam',
] as const;
export type RuleKey = (typeof RULE_KEYS)[number];

export const BUILTIN_VARIABLES = ['agente', 'negocio'] as const;
