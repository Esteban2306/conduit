jest.mock('@whiskeysockets/baileys', () => ({
  __esModule: true,
  default: jest.fn(),
  DisconnectReason: { loggedOut: 401 },
}));

import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import {
  LEGACY_USAGE_MIGRATION,
  LegacyImageUsageService,
} from 'src/bot/ai/LegacyImageUsage.service';
import { isolatedInfra } from '../../helpers/isolated-env';
import { createTestPrisma } from '../../helpers/prisma.helper';

const infra = isolatedInfra();
const suite = infra ? describe : describe.skip;
const DAY_MS = 86_400_000;

suite('Uso del camino antiguo contra la base aislada', () => {
  const run = randomUUID().slice(0, 8);
  const tenantA = `it-lu-a-${run}`;
  const tenantB = `it-lu-b-${run}`;
  let prisma: PrismaClient;
  let service: LegacyImageUsageService;
  let botA1: string;
  let botA2: string;
  let botB: string;

  const settle = () => new Promise((resolve) => setTimeout(resolve, 150));
  const rows = (botConfigId: string) =>
    prisma.legacyImageUsage.findMany({ where: { botConfigId } });

  beforeAll(async () => {
    prisma = createTestPrisma(infra!.databaseUrl);
    service = new LegacyImageUsageService(prisma as never);
    for (const id of [tenantA, tenantB]) {
      await prisma.tenant.create({ data: { id, name: id, slug: id } });
    }
    const bot = (tenantId: string, name: string) =>
      prisma.botConfig
        .create({ data: { tenantId, name, systemPrompt: 'x' } })
        .then((b) => b.id);
    botA1 = await bot(tenantA, 'a1');
    botA2 = await bot(tenantA, 'a2');
    botB = await bot(tenantB, 'b1');
  });

  afterAll(async () => {
    await prisma.legacyImageUsage.deleteMany({
      where: { tenantId: { in: [tenantA, tenantB] } },
    });
    await prisma.botConfig.deleteMany({
      where: { tenantId: { in: [tenantA, tenantB] } },
    });
    await prisma.tenant.deleteMany({
      where: { id: { in: [tenantA, tenantB] } },
    });
    await prisma.$disconnect();
  });

  it('suma por bot y día sin perder conteos aunque lleguen a la vez', async () => {
    for (let i = 0; i < 25; i++) service.record(tenantA, botA1);
    service.record(tenantA, botA2);
    await settle();

    const first = await rows(botA1);
    expect(first).toHaveLength(1);
    expect(first[0].calls).toBe(25);
    expect(first[0].tenantId).toBe(tenantA);
    expect((await rows(botA2))[0].calls).toBe(1);
  });

  it('el resumen suma la ventana del tenant, ordena y pone nombres', async () => {
    service.record(tenantB, botB);
    await settle();

    const summary = await service.summary(tenantA);
    expect(summary.windowDays).toBe(14);
    expect(summary.totalCalls).toBe(26);
    expect(summary.bots.map((b) => [b.name, b.calls])).toEqual([
      ['a1', 25],
      ['a2', 1],
    ]);
    expect(summary.lastUsedAt).toBeInstanceOf(Date);
    expect(summary.bots.every((b) => b.botConfigId !== botB)).toBe(true);
  });

  it('otro tenant no ve ni suma el uso ajeno', async () => {
    const summary = await service.summary(tenantB);
    expect(summary.totalCalls).toBe(1);
    expect(summary.bots).toHaveLength(1);
    expect(summary.bots[0].name).toBe('b1');
  });

  it('lo anterior a la ventana no cuenta y el límite del día es exacto', async () => {
    const day = (ago: number) => new Date(Date.now() - ago * DAY_MS);
    await prisma.legacyImageUsage.createMany({
      data: [
        {
          tenantId: tenantB,
          botConfigId: botA2,
          day: day(14),
          calls: 7,
          lastAt: day(14),
        },
        {
          tenantId: tenantB,
          botConfigId: botA1,
          day: day(13),
          calls: 3,
          lastAt: day(13),
        },
      ],
    });
    const summary = await service.summary(tenantB, 14);
    expect(summary.totalCalls).toBe(1 + 3);
    const narrow = await service.summary(tenantB, 5);
    expect(narrow.totalCalls).toBe(1);
  });

  it('los días fuera de rango se acotan', async () => {
    expect((await service.summary(tenantA, 0)).windowDays).toBe(1);
    expect((await service.summary(tenantA, 9999)).windowDays).toBe(90);
    expect((await service.summary(tenantA, Number.NaN)).windowDays).toBe(1);
  });

  it('conoce desde cuándo existe el contador por la migración aplicada', async () => {
    const [{ at }] = await prisma.$queryRaw<Array<{ at: Date }>>`
      SELECT finished_at AS at FROM "_prisma_migrations"
      WHERE migration_name = ${LEGACY_USAGE_MIGRATION}`;
    const summary = await service.summary(tenantA);
    expect(summary.observedSince?.getTime()).toBe(at.getTime());
  });

  describe('listo para retirar', () => {
    const observed = (daysAgo: number | null) =>
      jest
        .spyOn(
          service as unknown as { observedSince: () => Promise<Date | null> },
          'observedSince',
        )
        .mockResolvedValue(
          daysAgo === null ? null : new Date(Date.now() - daysAgo * DAY_MS),
        );
    afterEach(() => jest.restoreAllMocks());

    it('cero llamadas sin haber observado toda la ventana no prueba nada', async () => {
      observed(3);
      const tenant = await service.summary(`${tenantA}-vacio`, 14);
      expect(tenant.totalCalls).toBe(0);
      expect(tenant.retirementReady).toBe(false);
    });

    it('si no se sabe desde cuándo se observa, nunca está listo', async () => {
      observed(null);
      expect(
        (await service.summary(`${tenantA}-vacio`, 14)).retirementReady,
      ).toBe(false);
    });

    it('cero llamadas con toda la ventana observada sí está listo', async () => {
      observed(15);
      expect(
        (await service.summary(`${tenantA}-vacio`, 14)).retirementReady,
      ).toBe(true);
    });

    it('con una sola llamada en la ventana no está listo', async () => {
      observed(30);
      const summary = await service.summary(tenantA, 14);
      expect(summary.totalCalls).toBeGreaterThan(0);
      expect(summary.retirementReady).toBe(false);
    });
  });
});
