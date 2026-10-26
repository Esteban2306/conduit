export interface IntentSchedule {
  timeZone?: string;
  /** Ventanas semanales; sin ventanas, siempre dentro del rango de fechas. */
  windows?: Array<{
    /** 0 = domingo … 6 = sábado */
    days: number[];
    /** HH:MM */
    from: string;
    to: string;
  }>;
  validFrom?: string;
  validUntil?: string;
}

const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function toMinutes(clock: string): number | null {
  const match = CLOCK.exec(clock);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

export function validateSchedule(schedule: unknown): string | null {
  if (schedule === null || schedule === undefined) return null;
  if (typeof schedule !== 'object' || Array.isArray(schedule)) {
    return 'schedule debe ser un objeto';
  }
  const value = schedule as IntentSchedule;
  if (value.timeZone) {
    try {
      new Intl.DateTimeFormat('es', { timeZone: value.timeZone });
    } catch {
      return `Zona horaria inválida: ${value.timeZone}`;
    }
  }
  for (const key of ['validFrom', 'validUntil'] as const) {
    const raw = value[key];
    if (raw !== undefined && Number.isNaN(new Date(raw).getTime())) {
      return `${key} no es una fecha válida`;
    }
  }
  for (const window of value.windows ?? []) {
    if (
      !Array.isArray(window.days) ||
      window.days.length === 0 ||
      window.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)
    ) {
      return 'Cada ventana necesita days con enteros de 0 a 6';
    }
    if (toMinutes(window.from) === null || toMinutes(window.to) === null) {
      return 'Las horas de la ventana deben ser HH:MM';
    }
  }
  return null;
}

/**
 * ¿La intención está programada para ahora? Una ventana que cruza la
 * medianoche (22:00–06:00) cuenta como del día en que empieza.
 */
export function isScheduledNow(
  schedule: IntentSchedule | null | undefined,
  now: Date,
  defaultTimeZone: string,
): boolean {
  if (!schedule) return true;
  if (schedule.validFrom && now < new Date(schedule.validFrom)) return false;
  if (schedule.validUntil && now > new Date(schedule.validUntil)) return false;
  const windows = schedule.windows ?? [];
  if (windows.length === 0) return true;

  const timeZone = schedule.timeZone ?? defaultTimeZone;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const day = weekdays.indexOf(parts.weekday);
  const minute = Number(parts.hour) * 60 + Number(parts.minute);
  const previousDay = (day + 6) % 7;

  return windows.some((window) => {
    const from = toMinutes(window.from)!;
    const to = toMinutes(window.to)!;
    if (from <= to) {
      return window.days.includes(day) && minute >= from && minute < to;
    }
    return (
      (window.days.includes(day) && minute >= from) ||
      (window.days.includes(previousDay) && minute < to)
    );
  });
}
