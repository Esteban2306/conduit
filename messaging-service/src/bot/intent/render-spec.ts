import { getPath, isEmptyValue } from './path';

export type Transform =
  | 'capitalize'
  | 'upper'
  | 'lower'
  | 'datetime'
  | 'date'
  | 'time'
  | 'money_cop'
  | 'http_url';

export type Cond =
  | {
      path: string;
      equals?: unknown;
      notEquals?: unknown;
      exists?: boolean;
      empty?: boolean;
      gt?: number;
      lt?: number;
      /** El valor (una lista) contiene este elemento. */
      includes?: unknown;
    }
  | { all: Cond[] }
  | { any: Cond[] }
  | { not: Cond };

export interface ItemVariant {
  when?: Cond;
  text: string;
}

export interface ListSpec {
  path: string;
  item: string | ItemVariant[];
  separator?: string;
  groupBy?: string;
  groupHeader?: string;
  /** Más elementos que este tope: no se renderiza (el turno sigue a la IA). */
  limit?: number;
}

export type VarSpec =
  | string
  | {
      path: string;
      transform?: Transform;
      optional?: boolean;
      default?: string;
    }
  | { literal: string }
  | { list: ListSpec; optional?: boolean };

export interface Branch {
  when?: Cond;
  variant: string;
  vars?: Record<string, VarSpec>;
}

export interface RenderSpec {
  branches: Branch[];
  vars?: Record<string, VarSpec>;
}

export interface Rendered {
  variantKey: string;
  vars: Record<string, string>;
}

export interface RenderOptions {
  timeZone: string;
  /** Datos de la conversación disponibles como `$entity`, `$text`. */
  extras?: Record<string, unknown>;
}

const MAX_RENDERED_CHARS = 3500;
export const TRANSFORMS: readonly Transform[] = [
  'capitalize',
  'upper',
  'lower',
  'datetime',
  'date',
  'time',
  'money_cop',
  'http_url',
];

function dateParts(value: unknown, timeZone: string) {
  if (typeof value !== 'string' && !(value instanceof Date)) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return Object.fromEntries(
    new Intl.DateTimeFormat('es-CO', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone,
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
}

function clock(parts: Record<string, string>): string {
  const period = String(parts.dayPeriod)
    .replace(/\./g, '')
    .replace(/\s/g, '')
    .toLowerCase();
  return `${parts.hour}:${parts.minute} ${period}`;
}

export function applyTransform(
  value: unknown,
  transform: Transform | undefined,
  timeZone: string,
): string | null {
  if (isEmptyValue(value)) return null;
  const asText = typeof value === 'string' ? value.trim() : String(value);
  switch (transform) {
    case undefined:
      return typeof value === 'object' ? null : asText;
    case 'capitalize':
      return asText.charAt(0).toUpperCase() + asText.slice(1).toLowerCase();
    case 'upper':
      return asText.toUpperCase();
    case 'lower':
      return asText.toLowerCase();
    case 'money_cop': {
      const amount = Number(value);
      return Number.isFinite(amount)
        ? `$${amount.toLocaleString('es-CO')}`
        : null;
    }
    case 'http_url':
      return /^https?:\/\/\S+$/.test(asText) ? asText : null;
    case 'datetime':
    case 'date':
    case 'time': {
      const parts = dateParts(value, timeZone);
      if (!parts) return null;
      if (transform === 'time') return clock(parts);
      const day = `${parts.weekday} ${parts.day} de ${parts.month}`;
      return transform === 'date' ? day : `${day} a las ${clock(parts)}`;
    }
    default:
      return null;
  }
}

export function evalCond(cond: Cond, data: unknown): boolean {
  if ('all' in cond) return cond.all.every((c) => evalCond(c, data));
  if ('any' in cond) return cond.any.some((c) => evalCond(c, data));
  if ('not' in cond) return !evalCond(cond.not, data);
  const value = getPath(data, cond.path);
  if (cond.exists !== undefined && cond.exists !== (value !== undefined)) {
    return false;
  }
  if (cond.empty !== undefined && cond.empty !== isEmptyValue(value)) {
    return false;
  }
  if ('equals' in cond && value !== cond.equals) return false;
  if ('notEquals' in cond && value === cond.notEquals) return false;
  if ('includes' in cond) {
    if (!Array.isArray(value) || !value.includes(cond.includes)) return false;
  }
  if (cond.gt !== undefined && !(Number(value) > cond.gt)) return false;
  if (cond.lt !== undefined && !(Number(value) < cond.lt)) return false;
  return true;
}

function renderItem(
  template: string | ItemVariant[],
  item: unknown,
  timeZone: string,
): string | null {
  const text =
    typeof template === 'string'
      ? template
      : template.find((v) => !v.when || evalCond(v.when, item))?.text;
  if (text === undefined) return null;
  let failed = false;
  const out = text.replace(
    /\{(\.|\w[\w.[\]*]*)(?:\|(\w+))?\}/g,
    (_m, path: string, transform?: string) => {
      const value = applyTransform(
        path === '.' ? item : getPath(item, path),
        transform as Transform | undefined,
        timeZone,
      );
      if (value === null) failed = true;
      return value ?? '';
    },
  );
  return failed ? null : out;
}

function renderList(
  spec: ListSpec,
  data: unknown,
  timeZone: string,
): string | null {
  const raw = getPath(data, spec.path);
  const items = Array.isArray(raw) ? raw : [];
  if (items.length === 0) return null;
  if (spec.limit !== undefined && items.length > spec.limit) return null;

  const groups = new Map<string, string[]>();
  for (const item of items) {
    const line = renderItem(spec.item, item, timeZone);
    if (line === null) return null;
    const groupValue = spec.groupBy
      ? applyTransform(getPath(item, spec.groupBy), undefined, timeZone)
      : null;
    const key = groupValue ?? '';
    groups.set(key, [...(groups.get(key) ?? []), line]);
  }

  const separator = spec.separator ?? '\n';
  const blocks = [...groups.entries()].map(([group, lines]) => {
    const body = lines.join(separator);
    return group && spec.groupHeader
      ? `${spec.groupHeader.replace('{}', group)}\n${body}`
      : body;
  });
  return blocks.join('\n\n');
}

function resolveVar(
  spec: VarSpec,
  data: unknown,
  options: RenderOptions,
): string | null | undefined {
  if (typeof spec === 'string')
    return resolveVar({ path: spec }, data, options);
  if ('literal' in spec) return spec.literal;
  if ('list' in spec) {
    const rendered = renderList(spec.list, data, options.timeZone);
    return rendered ?? (spec.optional ? undefined : null);
  }
  const source = spec.path.startsWith('$')
    ? getPath(options.extras ?? {}, spec.path.slice(1))
    : getPath(data, spec.path);
  const value = applyTransform(source, spec.transform, options.timeZone);
  if (value !== null) return value;
  if (spec.default !== undefined) return spec.default;
  return spec.optional ? undefined : null;
}

/**
 * Elige la primera rama cuya condición se cumple y arma sus variables. Si
 * alguna variable obligatoria no tiene valor devuelve null: nunca se envía
 * una plantilla con huecos.
 */
export function renderTool(
  data: unknown,
  spec: RenderSpec,
  options: RenderOptions,
): Rendered | null {
  const branch = spec.branches.find((b) => !b.when || evalCond(b.when, data));
  if (!branch) return null;

  const vars: Record<string, string> = {};
  const merged = { ...(spec.vars ?? {}), ...(branch.vars ?? {}) };
  let total = 0;
  for (const [name, varSpec] of Object.entries(merged)) {
    const value = resolveVar(varSpec, data, options);
    if (value === null) return null;
    vars[name] = value ?? '';
    total += (value ?? '').length;
  }
  if (total > MAX_RENDERED_CHARS) return null;
  return { variantKey: branch.variant, vars };
}

/**
 * Una variable ausente invalida la plantilla; una presente y vacía (opcional
 * sin valor) se sustituye por texto vacío.
 */
export function fillTemplate(
  template: string,
  vars: Record<string, string>,
): string | null {
  let missing = false;
  const out = template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(vars, name)) {
      missing = true;
      return '';
    }
    return vars[name];
  });
  return missing ? null : out.replace(/\n{3,}/g, '\n\n').trim();
}
