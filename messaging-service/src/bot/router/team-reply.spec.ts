import {
  AWAITING_TEAM_KEY,
  asksForHairPhoto,
  TEAM_ANSWER_TAKEOVER_MS,
  answersWithAmount,
  awaitsTeamAnswer,
  takeoverEndsAt,
} from './team-reply';

const NOW = new Date('2026-11-23T18:00:00.000Z').getTime();
const TEN_MIN = 10 * 60 * 1000;

describe('respuesta del equipo a una foto que el bot le pasó', () => {
  it('tras el precio del equipo a la foto, el bot espera 5 minutos por si el equipo escribe algo más', () => {
    const createdAt = new Date(NOW - 5_000);
    expect(
      takeoverEndsAt({ createdAt, answersPhoto: true }, TEN_MIN, NOW),
    ).toEqual(new Date(createdAt.getTime() + TEAM_ANSWER_TAKEOVER_MS));
    expect(
      takeoverEndsAt(
        { createdAt: new Date(NOW - 6 * 60_000), answersPhoto: true },
        TEN_MIN,
        NOW,
      ),
    ).toBeNull();
  });

  it('cualquier otro mensaje del equipo mantiene la pausa normal', () => {
    const createdAt = new Date(NOW - 20_000);
    expect(
      takeoverEndsAt({ createdAt, answersPhoto: false }, TEN_MIN, NOW),
    ).toEqual(new Date(createdAt.getTime() + TEN_MIN));
  });

  it('espera la respuesta del equipo solo un tiempo y solo si trae un monto', () => {
    expect(
      awaitsTeamAnswer(
        { [AWAITING_TEAM_KEY]: new Date(NOW - 60_000).toISOString() },
        NOW,
      ),
    ).toBe(true);
    expect(
      awaitsTeamAnswer(
        { [AWAITING_TEAM_KEY]: new Date(NOW - 4 * 3_600_000).toISOString() },
        NOW,
      ),
    ).toBe(false);
    expect(awaitsTeamAnswer({}, NOW)).toBe(false);
    expect(answersWithAmount('Serán 200 para tu cabello')).toBe(true);
    expect(answersWithAmount('Te queda en $250.000')).toBe(true);
    expect(answersWithAmount('ya la reviso')).toBe(false);
    expect(answersWithAmount('te espero a las 10')).toBe(false);
    expect(answersWithAmount('a las 10:30 el 19/12')).toBe(false);
  });
});

describe('cuando el bot pide la foto del cabello', () => {
  it('reconoce el pedido de la foto del cabello', () => {
    expect(
      asksForHairPhoto(
        '¡Claro, Luz! 📸 Envíame una foto de tu cabello tomada desde atrás, suelta y nítida.',
      ),
    ).toBe(true);
    expect(asksForHairPhoto('Mándame una foto de tu pelo suelto')).toBe(true);
  });

  it('no confunde el pedido del comprobante ni otras frases', () => {
    expect(
      asksForHairPhoto('Envíame aquí la foto del comprobante del anticipo'),
    ).toBe(false);
    expect(asksForHairPhoto('Tu cabello quedará hermoso')).toBe(false);
  });
});
