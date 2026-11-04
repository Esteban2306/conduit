import {
  classifyDisconnect,
  countsAsFlap,
  FlapDetector,
  FLAP_THRESHOLD,
  FLAP_WINDOW_MS,
} from 'src/channels/whatsapp/baileys/disconnect-classifier';

const boom = (statusCode: number, message = 'Connection Closed') => ({
  message,
  output: { statusCode },
});

describe('classifyDisconnect', () => {
  it.each([
    [401, 'Intentional Logout', 'LOGGED_OUT'],
    [440, 'Stream Errored (conflict)', 'REPLACED'],
    [403, 'Connection Failure', 'FORBIDDEN'],
    [405, 'Connection Failure', 'OUTDATED_VERSION'],
    [515, 'Stream Errored (restart required)', 'RESTART'],
    [428, 'Connection Terminated', 'NETWORK'],
    [408, 'Connection was lost', 'NETWORK'],
    [503, 'Stream Errored (unavailable)', 'UNAVAILABLE'],
    [500, 'Stream Errored (unknown)', 'PROTOCOL'],
    [500, 'Connection Failure', 'PROTOCOL'],
  ])('%s "%s" es %s', (code, message, kind) => {
    expect(classifyDisconnect(boom(code, message)).kind).toBe(kind);
  });

  it('un conflicto de flujo es sesión reemplazada aunque el código sea otro', () => {
    expect(
      classifyDisconnect(boom(500, 'Stream Errored (conflict)')).kind,
    ).toBe('REPLACED');
  });

  it('sin código ni mensaje es protocolo, nunca bloqueo', () => {
    for (const input of [undefined, null, {}, 'boom', { output: {} }]) {
      expect(classifyDisconnect(input).kind).toBe('PROTOCOL');
    }
  });

  it('solo 401, 440 y 403 hablan de la cuenta', () => {
    const accountLevel = new Set(['LOGGED_OUT', 'REPLACED', 'FORBIDDEN']);
    for (let code = 400; code <= 599; code++) {
      const kind = classifyDisconnect(boom(code, 'x')).kind;
      expect(accountLevel.has(kind)).toBe([401, 440, 403].includes(code));
    }
  });
});

describe('FlapDetector', () => {
  it('cuenta los cierres de la última ventana y olvida los viejos', () => {
    const d = new FlapDetector();
    const t0 = 1_000_000;
    for (let i = 0; i < FLAP_THRESHOLD - 1; i++) d.record('c1', t0 + i * 1000);
    expect(d.record('c1', t0 + 5_000)).toBe(FLAP_THRESHOLD);
    expect(d.record('c1', t0 + FLAP_WINDOW_MS + 10_000)).toBe(1);
  });

  it('cada conexión cuenta por separado', () => {
    const d = new FlapDetector();
    d.record('a');
    d.record('a');
    expect(d.record('b')).toBe(1);
  });

  it('el 515 no cuenta como cierre inestable', () => {
    expect(countsAsFlap('RESTART')).toBe(false);
    expect(countsAsFlap('NETWORK')).toBe(true);
  });
});
