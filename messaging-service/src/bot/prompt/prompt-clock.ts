export function promptNow(timeZone: string, date: Date = new Date()): string {
  const human = new Intl.DateTimeFormat('es-CO', {
    timeZone,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
  return `${human} (${promptIsoDate(timeZone, date)}, hora de ${timeZone})`;
}

export function promptToday(timeZone: string, date: Date = new Date()): string {
  return new Intl.DateTimeFormat('es-CO', {
    timeZone,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(date);
}

export function promptIsoDate(
  timeZone: string,
  date: Date = new Date(),
): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}
