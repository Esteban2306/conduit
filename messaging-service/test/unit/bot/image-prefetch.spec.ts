import { ImagePrefetch } from 'src/bot/router/image-prefetch';

const SETTLE = 1500;

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe('ImagePrefetch', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  const make = (settleMs = SETTLE, ttlMs?: number) =>
    new ImagePrefetch<string>({
      settleMs,
      ...(ttlMs !== undefined && { ttlMs }),
    });

  it('no arranca antes de la ventana y sí al cumplirse', async () => {
    const prefetch = make();
    const run = jest.fn(() => Promise.resolve('listo'));
    prefetch.schedule('c1', 'm1', run);

    await jest.advanceTimersByTimeAsync(SETTLE - 1);
    expect(run).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(2);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('con ventana 0 arranca de inmediato', async () => {
    const prefetch = make(0);
    const run = jest.fn(() => Promise.resolve('listo'));
    prefetch.schedule('c1', 'm1', run);
    await jest.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('una ráfaga solo analiza la imagen más nueva', async () => {
    const prefetch = make();
    const first = jest.fn(() => Promise.resolve('uno'));
    const second = jest.fn(() => Promise.resolve('dos'));
    const third = jest.fn(() => Promise.resolve('tres'));

    prefetch.schedule('c1', 'm1', first);
    await jest.advanceTimersByTimeAsync(500);
    prefetch.schedule('c1', 'm2', second);
    await jest.advanceTimersByTimeAsync(500);
    prefetch.schedule('c1', 'm3', third);
    await jest.advanceTimersByTimeAsync(SETTLE + 10);

    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    expect(third).toHaveBeenCalledTimes(1);
    expect(await prefetch.take('c1', 'm3', 100)).toMatchObject({
      status: 'READY',
      value: 'tres',
    });
    expect(await prefetch.take('c1', 'm1', 100)).toMatchObject({
      status: 'MISSING',
    });
  });

  it('un solo análisis a la vez por conversación: la imagen nueva espera a que termine el que corre', async () => {
    const prefetch = make();
    const running = deferred<string>();
    const first = jest.fn(() => running.promise);
    const second = jest.fn(() => Promise.resolve('dos'));

    prefetch.schedule('c1', 'm1', first);
    await jest.advanceTimersByTimeAsync(SETTLE + 1);
    expect(first).toHaveBeenCalledTimes(1);

    prefetch.schedule('c1', 'm2', second);
    await jest.advanceTimersByTimeAsync(SETTLE + 1);
    expect(second).not.toHaveBeenCalled();

    running.resolve('uno');
    await jest.advanceTimersByTimeAsync(0);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('en la cola solo queda la más nueva', async () => {
    const prefetch = make();
    const running = deferred<string>();
    const queuedOld = jest.fn(() => Promise.resolve('viejo'));
    const queuedNew = jest.fn(() => Promise.resolve('nuevo'));

    prefetch.schedule('c1', 'm1', () => running.promise);
    await jest.advanceTimersByTimeAsync(SETTLE + 1);
    prefetch.schedule('c1', 'm2', queuedOld);
    prefetch.schedule('c1', 'm3', queuedNew);
    await jest.advanceTimersByTimeAsync(SETTLE + 1);

    running.resolve('uno');
    await jest.advanceTimersByTimeAsync(0);
    expect(queuedOld).not.toHaveBeenCalled();
    expect(queuedNew).toHaveBeenCalledTimes(1);
  });

  it('conversaciones distintas no se estorban', async () => {
    const prefetch = make();
    const blocked = deferred<string>();
    const other = jest.fn(() => Promise.resolve('otra'));
    prefetch.schedule('c1', 'm1', () => blocked.promise);
    prefetch.schedule('c2', 'm2', other);
    await jest.advanceTimersByTimeAsync(SETTLE + 1);
    expect(other).toHaveBeenCalledTimes(1);
  });

  it('take sobre una imagen que espera la ventana arranca de inmediato', async () => {
    const prefetch = make();
    const run = jest.fn(() => Promise.resolve('ya'));
    prefetch.schedule('c1', 'm1', run);

    const taken = await prefetch.take('c1', 'm1', 1000);
    expect(run).toHaveBeenCalledTimes(1);
    expect(taken).toMatchObject({ status: 'READY', value: 'ya' });

    await jest.advanceTimersByTimeAsync(SETTLE * 2);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('take espera al que corre y devuelve cuánto esperó', async () => {
    const prefetch = make(0);
    const running = deferred<string>();
    prefetch.schedule('c1', 'm1', () => running.promise);
    await jest.advanceTimersByTimeAsync(0);

    const taking = prefetch.take('c1', 'm1', 10_000);
    await jest.advanceTimersByTimeAsync(3_000);
    running.resolve('termino');
    const taken = await taking;

    expect(taken).toMatchObject({ status: 'READY', value: 'termino' });
    expect(taken.waitedMs).toBeGreaterThanOrEqual(3_000);
  });

  it('take se rinde tras la espera máxima y el resultado tardío no se pierde', async () => {
    const prefetch = make(0);
    const running = deferred<string>();
    prefetch.schedule('c1', 'm1', () => running.promise);
    await jest.advanceTimersByTimeAsync(0);

    const taking = prefetch.take('c1', 'm1', 5_000);
    await jest.advanceTimersByTimeAsync(5_001);
    expect(await taking).toMatchObject({ status: 'TIMEOUT' });

    running.resolve('tarde');
    await jest.advanceTimersByTimeAsync(0);
    expect(await prefetch.take('c1', 'm1', 100)).toMatchObject({
      status: 'READY',
      value: 'tarde',
    });
  });

  it('un fallo se informa como FAILED sin romper nada', async () => {
    const prefetch = make(0);
    prefetch.schedule('c1', 'm1', () => Promise.reject(new Error('boom')));
    await jest.advanceTimersByTimeAsync(0);
    expect(await prefetch.take('c1', 'm1', 100)).toMatchObject({
      status: 'FAILED',
    });
  });

  it('un mensaje desconocido es MISSING', async () => {
    const prefetch = make();
    expect(await prefetch.take('c1', 'nada', 100)).toMatchObject({
      status: 'MISSING',
    });
  });

  it('el resultado se puede pedir varias veces sin repetir el análisis', async () => {
    const prefetch = make(0);
    const run = jest.fn(() => Promise.resolve('unico'));
    prefetch.schedule('c1', 'm1', run);
    await jest.advanceTimersByTimeAsync(0);
    const a = await prefetch.take('c1', 'm1', 100);
    const b = await prefetch.take('c1', 'm1', 100);
    expect(a).toMatchObject({ status: 'READY', value: 'unico' });
    expect(b).toMatchObject({ status: 'READY', value: 'unico' });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('agendar dos veces el mismo mensaje no lo analiza dos veces', async () => {
    const prefetch = make();
    const run = jest.fn(() => Promise.resolve('x'));
    prefetch.schedule('c1', 'm1', run);
    prefetch.schedule('c1', 'm1', run);
    await jest.advanceTimersByTimeAsync(SETTLE + 1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('un mensaje ya analizado no se vuelve a agendar', async () => {
    const prefetch = make(0);
    const run = jest.fn(() => Promise.resolve('x'));
    prefetch.schedule('c1', 'm1', run);
    await jest.advanceTimersByTimeAsync(0);
    prefetch.schedule('c1', 'm1', run);
    await jest.advanceTimersByTimeAsync(SETTLE);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('descartar cancela lo que espera y borra el estado', async () => {
    const prefetch = make();
    const run = jest.fn(() => Promise.resolve('x'));
    prefetch.schedule('c1', 'm1', run);
    prefetch.discard('c1');
    await jest.advanceTimersByTimeAsync(SETTLE * 2);
    expect(run).not.toHaveBeenCalled();
    expect(prefetch.size()).toBe(0);
    expect(await prefetch.take('c1', 'm1', 100)).toMatchObject({
      status: 'MISSING',
    });
  });

  it('descartar mientras corre deja de entregar el resultado', async () => {
    const prefetch = make(0);
    const running = deferred<string>();
    prefetch.schedule('c1', 'm1', () => running.promise);
    await jest.advanceTimersByTimeAsync(0);
    prefetch.discard('c1');
    running.resolve('x');
    await jest.advanceTimersByTimeAsync(0);
    expect(await prefetch.take('c1', 'm1', 100)).toMatchObject({
      status: 'MISSING',
    });
  });

  it('los resultados viejos se purgan por tiempo', async () => {
    let clock = 1_000;
    const prefetch = new ImagePrefetch<string>({
      settleMs: 0,
      ttlMs: 60_000,
      now: () => clock,
    });
    prefetch.schedule('c1', 'm1', () => Promise.resolve('x'));
    await jest.advanceTimersByTimeAsync(0);
    expect(prefetch.size()).toBe(1);

    clock += 61_000;
    prefetch.schedule('c2', 'm2', () => Promise.resolve('y'));
    await jest.advanceTimersByTimeAsync(0);
    expect(await prefetch.take('c1', 'm1', 100)).toMatchObject({
      status: 'MISSING',
    });
  });
});
