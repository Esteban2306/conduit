import { IntentConfigService } from 'src/bot/intent/IntentConfig.service';
import { DEFAULT_INTENTS } from 'src/bot/intent/intent-catalog';

function build(rows: unknown[] | Error = []) {
  const upserts: unknown[] = [];
  const prisma = {
    botQuickReply: {
      findMany: jest.fn(() =>
        rows instanceof Error ? Promise.reject(rows) : Promise.resolve(rows),
      ),
      upsert: jest.fn((args: unknown) => {
        upserts.push(args);
        return Promise.resolve({});
      }),
    },
    botAiSettings: {
      findUnique: jest.fn(() =>
        Promise.resolve({ agentName: 'Sofía', companyName: 'Leonice Spa' }),
      ),
    },
  };
  const service = new IntentConfigService(
    prisma as never,
    {
      findOne: jest.fn(() => Promise.resolve({})),
    } as never,
  );
  (service as unknown as { logger: object }).logger = { warn: jest.fn() };
  return { service, prisma, upserts };
}

const intent = (id: string) => DEFAULT_INTENTS.find((i) => i.id === id)!;

describe('IntentConfigService', () => {
  afterEach(() => {
    delete process.env.INTENT_DEFAULT_MODE;
  });

  it('sin filas: modo SOMBRA, textos del catálogo e identidad del bot', async () => {
    const { service } = build();
    const settings = await service.forBot('bot');
    expect(settings.modeOf('cancel_booking')).toBe('SHADOW');
    expect(settings.variantsOf(intent('courtesy'), 'default').length).toBe(3);
    expect(settings.agent).toBe('Sofía');
    expect(settings.business).toBe('Leonice Spa');
  });

  it('INTENT_DEFAULT_MODE cambia el modo por defecto', async () => {
    process.env.INTENT_DEFAULT_MODE = 'ACTIVE';
    const { service } = build();
    expect((await service.forBot('bot')).modeOf('greeting')).toBe('ACTIVE');
  });

  it('una fila fija el modo y los textos de esa intención', async () => {
    const { service } = build([
      {
        intent: 'courtesy',
        mode: 'ACTIVE',
        variants: { default: ['Listo 🌿'] },
        cooldownSeconds: 120,
      },
    ]);
    const settings = await service.forBot('bot');
    expect(settings.modeOf('courtesy')).toBe('ACTIVE');
    expect(settings.modeOf('greeting')).toBe('SHADOW');
    expect(settings.variantsOf(intent('courtesy'), 'default')).toEqual([
      'Listo 🌿',
    ]);
    expect(settings.cooldownOf(intent('courtesy'))).toBe(120);
  });

  it('si la tabla no existe (migración pendiente) usa valores por defecto sin romper', async () => {
    const { service } = build(
      new Error('relation "BotQuickReply" does not exist'),
    );
    const settings = await service.forBot('bot');
    expect(settings.modeOf('greeting')).toBe('SHADOW');
  });

  it('rechaza intenciones desconocidas, variantes inexistentes y variables no disponibles', async () => {
    const { service } = build();
    await expect(
      service.upsert('bot', 't', 'nope', { mode: 'ACTIVE' }),
    ).rejects.toThrow(/desconocida/);
    await expect(
      service.upsert('bot', 't', 'courtesy', { variants: { otra: ['x'] } }),
    ).rejects.toThrow(/no tiene la variante/);
    await expect(
      service.upsert('bot', 't', 'courtesy', {
        variants: { default: ['Hola {{secreto}}'] },
      }),
    ).rejects.toThrow(/Variable \{\{secreto\}\}/);
    await expect(
      service.upsert('bot', 't', 'courtesy', { cooldownSeconds: -1 }),
    ).rejects.toThrow(/cooldownSeconds/);
  });

  it('guarda y sube la versión; invalida la caché', async () => {
    const { service, upserts, prisma } = build();
    await service.forBot('bot');
    await service.upsert('bot', 't', 'courtesy', {
      mode: 'ACTIVE',
      variants: { default: ['Con gusto {{agente}}'] },
    });
    expect(upserts).toHaveLength(1);
    await service.forBot('bot');
    expect(prisma.botQuickReply.findMany).toHaveBeenCalledTimes(2);
  });
});
