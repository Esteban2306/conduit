import {
  AWAITING_TEAM_KEY,
  TEAM_ANSWER_TAKEOVER_MS,
  answersWithAmount,
  awaitsTeamAnswer,
  takeoverEndsAt,
} from './team-reply';

const NOW = new Date('2026-11-23T18:00:00.000Z').getTime();
const TEN_MIN = 10 * 60 * 1000;

describe('respuesta del equipo a una foto que el bot le pasó', () => {
  it('el precio del equipo a la foto solo pausa el bot unos segundos', () => {
    const createdAt = new Date(NOW - 5_000);
    expect(
      takeoverEndsAt({ createdAt, answersPhoto: true }, TEN_MIN, NOW),
    ).toEqual(new Date(createdAt.getTime() + TEAM_ANSWER_TAKEOVER_MS));
    expect(
      takeoverEndsAt(
        { createdAt: new Date(NOW - 20_000), answersPhoto: true },
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
    expect(answersWithAmount('ya la reviso')).toBe(false);
  });
});
