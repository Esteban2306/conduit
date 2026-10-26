import { IntentId } from './intent-catalog';

export interface Rendered {
  variantKey: string;
  vars: Record<string, string>;
}

type Renderer = (data: unknown) => Rendered | null;

export const INTENT_VARIABLES: Record<IntentId, string[]> = {
  greeting: ['nombre', 'agente', 'negocio'],
  courtesy: ['agente', 'negocio'],
  cancel_booking: ['tratamiento', 'fecha', 'enlace'],
  cannot_attend: ['tratamiento', 'fecha', 'enlace'],
  business_hours: ['horario'],
  business_location: ['direccion'],
  cancellation_policy: ['politica'],
  deposit_info: ['anticipo'],
  my_bookings: ['citas'],
  deposit_status: ['pendientes'],
  treatments_list: ['lista', 'nota'],
  human_request: [],
  complaint: [],
};

const TIME_ZONE = 'America/Bogota';

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

export function formatWhen(value: unknown): string | null {
  if (typeof value !== 'string' && !(value instanceof Date)) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('es-CO', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: TIME_ZONE,
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  return `${parts.weekday} ${parts.day} de ${parts.month} a las ${parts.hour}:${parts.minute} ${String(parts.dayPeriod).replace(/\./g, '').replace(/\s/g, '').toLowerCase()}`;
}

export function fillTemplate(
  template: string,
  vars: Record<string, string>,
): string | null {
  let missing = false;
  const out = template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, name: string) => {
    const value = vars[name];
    if (value === undefined || value === '') {
      missing = true;
      return '';
    }
    return value;
  });
  return missing ? null : out;
}

const capitalize = (value: string) =>
  value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();

const cancellationLink = (data: unknown): Rendered | null => {
  const body = asRecord(data);
  if (!body) return null;
  if (body.hasUpcoming === false) return { variantKey: 'none', vars: {} };
  const url = text(body.url);
  const treatment = text(body.treatment);
  const when = formatWhen(body.scheduledStart);
  if (!url || !/^https?:\/\//.test(url) || !treatment || !when) return null;
  const many =
    Number(body.sameDayCount ?? 1) > 1 || Number(body.upcomingDays ?? 1) > 1;
  return {
    variantKey: many ? 'linkMany' : 'link',
    vars: { tratamiento: treatment, fecha: when, enlace: url },
  };
};

export const RENDERERS: Partial<Record<IntentId, Renderer>> = {
  greeting: (data): Rendered => {
    const body = asRecord(data);
    const first = text(body?.firstName);
    if (body?.registered === true && first) {
      return { variantKey: 'registered', vars: { nombre: capitalize(first) } };
    }
    return { variantKey: 'default', vars: {} };
  },
  courtesy: (): Rendered => ({ variantKey: 'default', vars: {} }),
  cancel_booking: cancellationLink,
  cannot_attend: cancellationLink,
  business_hours: (data) => {
    const schedule = asRecord(data)?.weeklySchedule;
    if (!Array.isArray(schedule) || schedule.length === 0) return null;
    const lines = schedule
      .map((row) => asRecord(row))
      .filter((row) => row && text(row.day) && text(row.hours))
      .map((row) => `• ${capitalize(String(row!.day))}: ${String(row!.hours)}`);
    return lines.length === 0
      ? null
      : { variantKey: 'default', vars: { horario: lines.join('\n') } };
  },
  business_location: (data) => {
    const address = text(asRecord(data)?.address);
    return address
      ? { variantKey: 'default', vars: { direccion: address } }
      : null;
  },
  cancellation_policy: (data) => {
    const policy = text(asRecord(data)?.cancellationPolicy);
    return policy
      ? { variantKey: 'default', vars: { politica: policy } }
      : null;
  },
  deposit_info: (data) => {
    const body = asRecord(data);
    const amount = Number(body?.depositAmountCop);
    const lines = [
      Number.isFinite(amount) && amount > 0
        ? `Valor: $${amount.toLocaleString('es-CO')}`
        : null,
      text(body?.depositInstructions),
      text(body?.depositPolicy),
      text(body?.depositDeadline),
    ].filter((line): line is string => line !== null);
    return lines.length === 0
      ? null
      : { variantKey: 'default', vars: { anticipo: lines.join('\n') } };
  },
  my_bookings: (data): Rendered | null => {
    const days = asRecord(data)?.days;
    if (!Array.isArray(days)) return null;
    const lines: string[] = [];
    for (const day of days) {
      const reservations = asRecord(day)?.reservations;
      if (!Array.isArray(reservations)) return null;
      for (const item of reservations) {
        const row = asRecord(item);
        const treatment = text(row?.treatment);
        const when = formatWhen(row?.scheduledStart);
        if (!treatment || !when) return null;
        lines.push(`• ${treatment} — ${when}`);
      }
    }
    return lines.length === 0
      ? { variantKey: 'none', vars: {} }
      : { variantKey: 'some', vars: { citas: lines.join('\n') } };
  },
  deposit_status: (data): Rendered | null => {
    const candidates = asRecord(data)?.candidates;
    if (!Array.isArray(candidates)) return null;
    if (candidates.length === 0) return { variantKey: 'none', vars: {} };
    const lines: string[] = [];
    for (const item of candidates) {
      const row = asRecord(item);
      const treatment = text(row?.treatmentName);
      const when = formatWhen(row?.scheduledStart);
      if (!treatment || !when) return null;
      lines.push(`• ${treatment} — ${when}`);
    }
    return { variantKey: 'some', vars: { pendientes: lines.join('\n') } };
  },
  treatments_list: (data): Rendered | null => {
    if (!Array.isArray(data) || data.length === 0 || data.length > 25) {
      return null;
    }
    const groups = new Map<string, string[]>();
    let hasRange = false;
    for (const item of data) {
      const row = asRecord(item);
      const name = text(row?.name);
      if (!name) return null;
      const price = text(row?.price);
      if (row?.priceIsRange === true) hasRange = true;
      const promotion = asRecord(row?.promotion);
      const promo =
        promotion && text(promotion.discount) && text(promotion.price)
          ? ` · promo ${String(promotion.discount)}: ${String(promotion.price)}`
          : '';
      const category = text(row?.category) ?? '';
      const lines = groups.get(category) ?? [];
      lines.push(price ? `• ${name} — ${price}${promo}` : `• ${name}`);
      groups.set(category, lines);
    }
    const blocks = [...groups.entries()].map(([category, lines]) =>
      category ? `*${category}*\n${lines.join('\n')}` : lines.join('\n'),
    );
    return {
      variantKey: 'default',
      vars: {
        lista: blocks.join('\n\n'),
        nota: hasRange
          ? '\n\nLos precios con rango se confirman en la valoración en el spa.'
          : ' ',
      },
    };
  },
  human_request: () => ({ variantKey: 'default', vars: {} }),
  complaint: () => ({ variantKey: 'default', vars: {} }),
};
