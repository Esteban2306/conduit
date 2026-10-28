import { RetainedImages } from 'src/bot/router/retained-images';

describe('RetainedImages', () => {
  let clock: number;
  const images = () => new RetainedImages<string>(1000, () => clock);

  beforeEach(() => {
    clock = 0;
  });

  it('la imagen sigue disponible en los turnos siguientes hasta que se usa', () => {
    const store = images();
    store.keep('c1', 'foto');
    expect(store.get('c1')).toBe('foto');
    clock = 900;
    expect(store.get('c1')).toBe('foto');
  });

  it('consumirla la retira', () => {
    const store = images();
    store.keep('c1', 'foto');
    store.consume('c1');
    expect(store.get('c1')).toBeUndefined();
  });

  it('caduca pasado el plazo y no se usa una foto vieja', () => {
    const store = images();
    store.keep('c1', 'foto');
    clock = 1001;
    expect(store.get('c1')).toBeUndefined();
  });

  it('una imagen nueva reemplaza a la anterior y las conversaciones no se mezclan', () => {
    const store = images();
    store.keep('c1', 'vieja');
    store.keep('c2', 'otra clienta');
    store.keep('c1', 'nueva');
    expect(store.get('c1')).toBe('nueva');
    expect(store.get('c2')).toBe('otra clienta');
  });
});
