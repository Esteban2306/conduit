import {
  BUILTIN_VARIABLES,
  HandlerKind,
  IntentConfig,
  RULE_KEY_PREFIX,
  RULE_KEYS,
} from './intent-types';
import { Branch, Cond, RenderSpec, TRANSFORMS, VarSpec } from './render-spec';
import { validateSchedule } from './schedule';

export const MAX_PATTERN_CHARS = 500;
export const MAX_PATTERNS = 40;
const MAX_VARIANT_CHARS = 1000;
const MAX_VARIANTS_PER_KEY = 6;
const KEY_FORMAT = /^[a-z][a-z0-9_.-]{1,62}$/;
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)[+*{]/;
const HANDLERS: HandlerKind[] = [
  'TEMPLATE',
  'TOOL_DIRECT',
  'HANDOFF',
  'LLM_SLIM',
];

/**
 * Los patrones los escribe el negocio: se rechazan los que no compilan, son
 * enormes o tienen cuantificadores anidados (retroceso catastrófico), y se
 * prueba cada uno contra una entrada hostil con límite de tiempo.
 */
export function checkPattern(source: unknown): string | null {
  if (typeof source !== 'string' || source.trim() === '') {
    return 'cada patrón debe ser un texto no vacío';
  }
  if (source.length > MAX_PATTERN_CHARS) {
    return `un patrón supera ${MAX_PATTERN_CHARS} caracteres`;
  }
  if (NESTED_QUANTIFIER.test(source)) {
    return `patrón con cuantificadores anidados (riesgo de bloqueo): ${source.slice(0, 60)}`;
  }
  let regex: RegExp;
  try {
    regex = new RegExp(source);
  } catch {
    return `patrón inválido: ${source.slice(0, 60)}`;
  }
  const started = Date.now();
  regex.test('a '.repeat(80) + '!');
  regex.test('hola '.repeat(40));
  if (Date.now() - started > 50) {
    return `patrón demasiado lento: ${source.slice(0, 60)}`;
  }
  return null;
}

function collectCondPaths(cond: Cond | undefined, out: string[]): void {
  if (!cond) return;
  if ('all' in cond) cond.all.forEach((c) => collectCondPaths(c, out));
  else if ('any' in cond) cond.any.forEach((c) => collectCondPaths(c, out));
  else if ('not' in cond) collectCondPaths(cond.not, out);
}

function varProblems(name: string, spec: VarSpec): string[] {
  if (typeof spec === 'string') return [];
  if ('literal' in spec) return [];
  if ('list' in spec) {
    const list = spec.list;
    if (typeof list.path !== 'string') return [`${name}: list.path requerido`];
    if (typeof list.item !== 'string' && !Array.isArray(list.item)) {
      return [`${name}: list.item requerido`];
    }
    return [];
  }
  if (typeof spec.path !== 'string') return [`${name}: path requerido`];
  if (spec.transform && !TRANSFORMS.includes(spec.transform)) {
    return [`${name}: transformación desconocida ${spec.transform}`];
  }
  return [];
}

export function renderVariables(render: RenderSpec): Set<string> {
  const names = new Set<string>(Object.keys(render.vars ?? {}));
  for (const branch of render.branches) {
    Object.keys(branch.vars ?? {}).forEach((n) => names.add(n));
  }
  return names;
}

function renderProblems(render: unknown): string[] {
  if (!render || typeof render !== 'object') return ['render requerido'];
  const spec = render as RenderSpec;
  if (!Array.isArray(spec.branches) || spec.branches.length === 0) {
    return ['render.branches necesita al menos una rama'];
  }
  const problems: string[] = [];
  for (const [name, v] of Object.entries(spec.vars ?? {})) {
    problems.push(...varProblems(name, v));
  }
  spec.branches.forEach((branch: Branch, index) => {
    if (typeof branch.variant !== 'string' || branch.variant === '') {
      problems.push(`render.branches[${index}].variant requerido`);
    }
    for (const [name, v] of Object.entries(branch.vars ?? {})) {
      problems.push(...varProblems(name, v));
    }
    collectCondPaths(branch.when, []);
  });
  return problems;
}

export interface IntentInput {
  key?: unknown;
  name?: unknown;
  description?: unknown;
  handler?: unknown;
  mode?: unknown;
  priority?: unknown;
  patterns?: unknown;
  denyPatterns?: unknown;
  maxTokens?: unknown;
  respectsOpenFlow?: unknown;
  allowsQuestion?: unknown;
  negationOk?: unknown;
  fixedConfidence?: unknown;
  aiClassifiable?: unknown;
  config?: unknown;
  variants?: unknown;
  cooldownSeconds?: unknown;
  schedule?: unknown;
  notes?: unknown;
}

/** Devuelve la lista de problemas; vacía si la definición es válida. */
export function validateIntentInput(input: IntentInput): string[] {
  const problems: string[] = [];
  const key = input.key;
  if (typeof key !== 'string' || !KEY_FORMAT.test(key)) {
    problems.push('key debe ser minúsculas, dígitos, _ . - (2 a 63)');
    return problems;
  }
  const isRule = key.startsWith(RULE_KEY_PREFIX);
  if (isRule && !(RULE_KEYS as readonly string[]).includes(key)) {
    problems.push(`Clave reservada desconocida: ${key}`);
  }
  if (typeof input.name !== 'string' || input.name.trim() === '') {
    problems.push('name requerido');
  }
  if (!HANDLERS.includes(input.handler as HandlerKind)) {
    problems.push(`handler debe ser uno de ${HANDLERS.join(', ')}`);
    return problems;
  }
  const handler = input.handler as HandlerKind;

  if (
    input.mode !== undefined &&
    !['OFF', 'SHADOW', 'ACTIVE'].includes(String(input.mode))
  ) {
    problems.push('mode inválido');
  }
  for (const [field, min, max] of [
    ['priority', 0, 1000],
    ['maxTokens', 1, 60],
    ['cooldownSeconds', 0, 86_400],
  ] as const) {
    const value = input[field];
    if (
      value !== undefined &&
      (!Number.isInteger(value) ||
        (value as number) < min ||
        (value as number) > max)
    ) {
      problems.push(`${field} fuera de rango (${min}–${max})`);
    }
  }
  if (
    input.fixedConfidence !== undefined &&
    input.fixedConfidence !== null &&
    (typeof input.fixedConfidence !== 'number' ||
      input.fixedConfidence < 0 ||
      input.fixedConfidence > 1)
  ) {
    problems.push('fixedConfidence debe estar entre 0 y 1');
  }

  const patterns = input.patterns ?? [];
  if (!Array.isArray(patterns) || patterns.length > MAX_PATTERNS) {
    problems.push(`patterns debe ser una lista de hasta ${MAX_PATTERNS}`);
  } else {
    if (!isRule && patterns.length === 0 && input.handler !== 'LLM_SLIM') {
      problems.push('patterns necesita al menos un patrón');
    }
    for (const p of patterns) {
      const problem = checkPattern(p);
      if (problem) problems.push(problem);
    }
  }
  const deny = input.denyPatterns ?? [];
  if (!Array.isArray(deny) || deny.length > MAX_PATTERNS) {
    problems.push(`denyPatterns debe ser una lista de hasta ${MAX_PATTERNS}`);
  } else {
    for (const p of deny) {
      const problem = checkPattern(p);
      if (problem) problems.push(problem);
    }
  }

  const schedule = validateSchedule(input.schedule);
  if (schedule) problems.push(schedule);

  const variants = (input.variants ?? {}) as Record<string, unknown>;
  const variantKeys = Object.keys(variants);
  if (typeof variants !== 'object' || Array.isArray(variants)) {
    problems.push('variants debe ser un objeto');
    return problems;
  }
  for (const vk of variantKeys) {
    const list = variants[vk];
    if (
      !Array.isArray(list) ||
      list.length === 0 ||
      list.length > MAX_VARIANTS_PER_KEY ||
      list.some(
        (t) =>
          typeof t !== 'string' ||
          t.trim() === '' ||
          t.length > MAX_VARIANT_CHARS,
      )
    ) {
      problems.push(
        `variants.${vk}: entre 1 y ${MAX_VARIANTS_PER_KEY} textos no vacíos de máximo ${MAX_VARIANT_CHARS} caracteres`,
      );
    }
  }

  const config = (input.config ?? {}) as IntentConfig;
  if (typeof config !== 'object' || Array.isArray(config)) {
    problems.push('config debe ser un objeto');
    return problems;
  }
  const known = new Set<string>(BUILTIN_VARIABLES);

  if ((handler === 'TEMPLATE' || handler === 'HANDOFF') && !isRule) {
    if (!variants.default) problems.push('variants.default requerido');
  }
  if (
    handler === 'HANDOFF' &&
    (!config.reason || typeof config.reason !== 'string')
  ) {
    problems.push('config.reason requerido en HANDOFF');
  }
  if (handler === 'TOOL_DIRECT') {
    if (!config.tool || typeof config.tool !== 'string') {
      problems.push('config.tool requerido en TOOL_DIRECT');
    }
    const renderIssues = renderProblems(config.render);
    problems.push(...renderIssues);
    if (renderIssues.length === 0) {
      renderVariables(config.render!).forEach((n) => known.add(n));
      for (const branch of config.render!.branches) {
        if (!variants[branch.variant]) {
          problems.push(`falta variants.${branch.variant} (lo usa render)`);
        }
      }
    }
    if (config.cache) {
      if (
        !['bot', 'contact'].includes(config.cache.scope) ||
        !Number.isInteger(config.cache.seconds) ||
        config.cache.seconds < 1 ||
        config.cache.seconds > 3600
      ) {
        problems.push('config.cache: scope bot|contact y seconds 1–3600');
      }
    }
    for (const [name, value] of Object.entries(config.params ?? {})) {
      if (typeof value !== 'string')
        problems.push(`params.${name} debe ser texto`);
      if (
        value === '$entity' &&
        !(patterns as string[]).some((p) => /\(\?<entity>/.test(String(p)))
      ) {
        problems.push(
          'params usa $entity pero ningún patrón define el grupo (?<entity>…)',
        );
      }
    }
  }
  if (handler === 'LLM_SLIM') {
    const slim = config.slim;
    if (!slim || typeof slim.prompt !== 'string' || slim.prompt.trim() === '') {
      problems.push('config.slim.prompt requerido');
    } else if (slim.prompt.length > 6000) {
      problems.push('config.slim.prompt supera 6000 caracteres');
    }
    if (
      !slim ||
      !Array.isArray(slim.tools) ||
      slim.tools.length > 20 ||
      slim.tools.some((t) => typeof t !== 'string')
    ) {
      problems.push(
        'config.slim.tools debe ser una lista de nombres (máx. 20)',
      );
    }
  }

  for (const [vk, list] of Object.entries(variants)) {
    if (!Array.isArray(list)) continue;
    for (const text of list as string[]) {
      if (typeof text !== 'string') continue;
      for (const match of text.matchAll(/\{\{\s*(\w+)\s*\}\}/g)) {
        if (handler === 'TEMPLATE' || handler === 'HANDOFF') {
          if (!known.has(match[1])) {
            problems.push(
              `variants.${vk}: variable {{${match[1]}}} no disponible. Disponibles: ${[...known].join(', ')}`,
            );
          }
        } else if (!known.has(match[1])) {
          problems.push(
            `variants.${vk}: variable {{${match[1]}}} no la entrega render. Disponibles: ${[...known].join(', ')}`,
          );
        }
      }
    }
  }
  return problems;
}
