import { SystemPauseService } from 'src/bot/pause/SystemPause.service';

function build(initial: Date | null = null) {
  let stored = initial;
  const prisma = {
    tenant: {
      findUnique: jest.fn(() => Promise.resolve({ systemPausedAt: stored })),
      update: jest.fn(({ data }: { data: { systemPausedAt: Date | null } }) => {
        stored = data.systemPausedAt;
        return Promise.resolve({ systemPausedAt: stored });
      }),
    },
  };
  return { service: new SystemPauseService(prisma as never), prisma };
}

describe('SystemPauseService', () => {
  it('por defecto el sistema no está en pausa', async () => {
    const { service } = build();
    expect(await service.get('t1')).toEqual({ paused: false, pausedAt: null });
  });

  it('pausar guarda la fecha y reanudar la borra', async () => {
    const { service } = build();
    const paused = await service.set('t1', true);
    expect(paused.paused).toBe(true);
    expect(paused.pausedAt).toBeInstanceOf(Date);
    expect(await service.isPaused('t1')).toBe(true);

    const resumed = await service.set('t1', false);
    expect(resumed).toEqual({ paused: false, pausedAt: null });
    expect(await service.isPaused('t1')).toBe(false);
  });

  it('pausar dos veces no cambia la fecha original', async () => {
    const { service, prisma } = build();
    const first = await service.set('t1', true);
    const second = await service.set('t1', true);
    expect(second.pausedAt).toEqual(first.pausedAt);
    expect(prisma.tenant.update).toHaveBeenCalledTimes(1);
  });

  it('lee la base una sola vez dentro de la ventana de caché', async () => {
    const { service, prisma } = build();
    await service.isPaused('t1');
    await service.isPaused('t1');
    expect(prisma.tenant.findUnique).toHaveBeenCalledTimes(1);
  });

  it('cada empresa tiene su propio estado', async () => {
    const { service } = build();
    await service.set('t1', true);
    expect(await service.isPaused('t1')).toBe(true);
  });

  it('si la base falla, no tumba al bot: usa el último estado conocido', async () => {
    const { service, prisma } = build();
    await service.set('t1', true);
    jest.useFakeTimers();
    jest.setSystemTime(Date.now() + 60_000);
    try {
      prisma.tenant.findUnique.mockRejectedValueOnce(new Error('columna'));
      expect(await service.isPaused('t1')).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('si nunca pudo leer la base, el bot sigue respondiendo', async () => {
    const { service, prisma } = build();
    prisma.tenant.findUnique.mockRejectedValue(new Error('columna'));
    expect(await service.isPaused('t1')).toBe(false);
  });
});
