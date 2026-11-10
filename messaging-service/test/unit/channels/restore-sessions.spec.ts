import { restoreSessions } from 'src/channels/whatsapp/restore-sessions';

const logger = () => ({ log: jest.fn(), error: jest.fn() });

describe('restauración de sesiones al arrancar', () => {
  it('inicia todas las conexiones pendientes, no solo la primera', async () => {
    const start = jest.fn<Promise<void>, [string]>().mockResolvedValue();
    const result = await restoreSessions(
      {
        findConnectionsToRestore: () =>
          Promise.resolve([{ id: 'a' }, { id: 'b' }]),
      },
      { start },
      logger(),
    );
    expect(start.mock.calls.map((c) => c[0])).toEqual(['a', 'b']);
    expect(result).toEqual({ started: 2, failed: 0 });
  });

  it('si una sesión falla lo deja en el log y las demás igual arrancan', async () => {
    const log = logger();
    const start = jest.fn(
      (id: string): Promise<void> =>
        id === 'a'
          ? Promise.reject(new Error('credenciales'))
          : Promise.resolve(),
    );
    const result = await restoreSessions(
      {
        findConnectionsToRestore: () =>
          Promise.resolve([{ id: 'a' }, { id: 'b' }]),
      },
      { start },
      log,
    );
    expect(result).toEqual({ started: 1, failed: 1 });
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining('conexión a: credenciales'),
    );
  });

  it('sin conexiones pendientes no hace nada y no falla', async () => {
    const start = jest.fn<Promise<void>, [string]>();
    const result = await restoreSessions(
      { findConnectionsToRestore: () => Promise.resolve([]) },
      { start },
      logger(),
    );
    expect(start).not.toHaveBeenCalled();
    expect(result).toEqual({ started: 0, failed: 0 });
  });
});
