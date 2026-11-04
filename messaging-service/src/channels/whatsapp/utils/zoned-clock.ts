const SECONDS_PER_DAY = 24 * 60 * 60;

export interface ZonedInstant {
  /** Fecha civil en la zona, formato YYYY-MM-DD. Sirve como clave de "día". */
  dateKey: string;
  /** Hora civil en la zona (0-23). */
  hour: number;
  /** Segundos transcurridos desde la medianoche civil de la zona. */
  secondsOfDay: number;
}

/**
 * Reloj de pared en una zona horaria IANA, independiente de la zona del
 * servidor (los contenedores suelen correr en UTC). Usa los datos de zonas
 * de ICU que trae Node, no los del sistema operativo.
 *
 * Supone días de 24 h: en zonas con horario de verano, los cálculos del día
 * del cambio pueden desviarse una hora (no aplica a America/Bogota).
 */
export class ZonedClock {
  private readonly formatter: Intl.DateTimeFormat;

  constructor(readonly timeZone: string) {
    this.formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
  }

  static isValidTimeZone(timeZone: string): boolean {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone });
      return true;
    } catch {
      return false;
    }
  }

  at(date: Date = new Date()): ZonedInstant {
    const parts: Record<string, string> = {};
    for (const part of this.formatter.formatToParts(date)) {
      parts[part.type] = part.value;
    }

    const hour = Number(parts.hour);
    return {
      dateKey: `${parts.year}-${parts.month}-${parts.day}`,
      hour,
      secondsOfDay:
        hour * 3600 + Number(parts.minute) * 60 + Number(parts.second),
    };
  }

  /**
   * Milisegundos hasta la próxima vez que el reloj de la zona marque
   * `hour`:00:00. Con `skipToday`, apunta siempre a esa hora del día
   * siguiente aunque hoy todavía no haya llegado.
   */
  msUntilHour(
    hour: number,
    date: Date = new Date(),
    options: { skipToday?: boolean } = {},
  ): number {
    const { secondsOfDay } = this.at(date);
    const target = hour * 3600;

    let deltaSeconds = target - secondsOfDay;
    if (options.skipToday) {
      deltaSeconds += SECONDS_PER_DAY;
    } else if (deltaSeconds <= 0) {
      deltaSeconds += SECONDS_PER_DAY;
    }

    return deltaSeconds * 1000 - date.getUTCMilliseconds();
  }
}
