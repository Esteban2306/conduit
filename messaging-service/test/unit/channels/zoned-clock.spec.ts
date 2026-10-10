import { ZonedClock } from 'src/channels/whatsapp/utils/zoned-clock';

const HOUR = 3600_000;
const bogota = new ZonedClock('America/Bogota');

describe('ZonedClock (America/Bogota, UTC-5)', () => {
  it('interpreta la hora civil de Bogotá, no la del servidor', () => {
    // 2026-10-10 02:00 UTC = 2026-10-09 21:00 en Bogotá
    const at = bogota.at(new Date('2026-10-10T02:00:00Z'));
    expect(at.hour).toBe(21);
    expect(at.dateKey).toBe('2026-10-09');
  });

  it('cambia de día a la medianoche de Bogotá (05:00 UTC)', () => {
    expect(bogota.at(new Date('2026-10-10T04:59:59Z')).dateKey).toBe(
      '2026-10-09',
    );
    expect(bogota.at(new Date('2026-10-10T05:00:00Z')).dateKey).toBe(
      '2026-10-10',
    );
  });

  it('a las 7:00 de Bogotá faltan 60 min para las 8:00 del mismo día', () => {
    expect(bogota.msUntilHour(8, new Date('2026-10-10T12:00:00Z'))).toBe(HOUR);
  });

  it('a las 21:30 de Bogotá la próxima 8:00 es la de mañana', () => {
    expect(bogota.msUntilHour(8, new Date('2026-10-11T02:30:00Z'))).toBe(
      10.5 * HOUR,
    );
  });

  it('exactamente a las 8:00 apunta a mañana (no devuelve 0)', () => {
    expect(bogota.msUntilHour(8, new Date('2026-10-10T13:00:00Z'))).toBe(
      24 * HOUR,
    );
  });

  it('skipToday apunta a mañana aunque hoy no haya llegado la hora', () => {
    expect(
      bogota.msUntilHour(8, new Date('2026-10-10T12:00:00Z'), {
        skipToday: true,
      }),
    ).toBe(25 * HOUR);
  });

  it('descuenta los milisegundos del instante actual', () => {
    expect(bogota.msUntilHour(8, new Date('2026-10-10T12:59:59.250Z'))).toBe(
      750,
    );
  });

  it('valida zonas IANA', () => {
    expect(ZonedClock.isValidTimeZone('America/Bogota')).toBe(true);
    expect(ZonedClock.isValidTimeZone('Bogota')).toBe(false);
  });
});
