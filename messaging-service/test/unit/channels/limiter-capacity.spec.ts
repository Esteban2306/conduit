import {
  BaileysRateLimiter,
  JobPriority,
  WarmupLevel,
} from 'src/channels/whatsapp/baileys/BaileysRateLimiter';

const START = new Date('2026-10-12T13:00:00Z');
const HOUR = 3_600_000;
const TYPING_MS = 3_000;

const CAPS = {
  [WarmupLevel.FRESH]: { replies: 60, campaignHour: 6, campaignDay: 40 },
  [WarmupLevel.NORMAL]: { replies: 120, campaignHour: 18, campaignDay: 180 },
  [WarmupLevel.TRUSTED]: { replies: 180, campaignHour: 25, campaignDay: 280 },
};

function maxIn(window: number, times: number[]): number {
  let best = 0;
  for (let i = 0, j = 0; i < times.length; i++) {
    while (times[i] - times[j] >= window) j++;
    best = Math.max(best, i - j + 1);
  }
  return best;
}

describe('Capacidad real del limitador (saturado y con 3 s de "escribiendo" por mensaje)', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  describe.each(Object.values(WarmupLevel))('nivel %s', (level) => {
    it('respuestas: nunca pasan del 150 % del ritmo habitual y, antes de ese techo, ninguna espera más de 1 minuto', async () => {
      jest.useFakeTimers({ now: START });
      const rl = new BaileysRateLimiter('cap-conv', level);
      const sentAt: number[] = [];
      for (let i = 0; i < 1000; i++) {
        void rl.enqueue(
          async () => {
            await new Promise((r) => setTimeout(r, TYPING_MS));
            sentAt.push(Date.now());
            return { success: true };
          },
          { priority: JobPriority.CONVERSATION, maxAttempts: 1 },
        );
      }
      await jest.advanceTimersByTimeAsync(3 * HOUR);

      const perHour = maxIn(HOUR, sentAt);
      const perMinute = maxIn(60_000, sentAt);
      const minGap = Math.min(...sentAt.slice(1).map((t, i) => t - sentAt[i]));
      const usual = CAPS[level].replies;
      const ceiling = Math.floor(usual * 1.5);
      const gaps = sentAt.slice(1, ceiling).map((t, i) => t - sentAt[i]);
      const longestGap = Math.max(...gaps);
      console.log(
        `[capacidad] ${level} respuestas: ${perHour}/h máximo (habitual ${usual}, techo ${ceiling}), ${perMinute}/min máximo, separación mínima ${Math.round(minGap / 100) / 10}s, espera más larga antes del techo ${Math.round(longestGap / 1000)}s`,
      );
      expect(perHour).toBeLessThanOrEqual(ceiling);
      expect(perHour).toBeGreaterThanOrEqual(ceiling - 5);
      expect(minGap).toBeGreaterThanOrEqual(3_000);
      expect(longestGap).toBeLessThanOrEqual(60_000);
    });

    it('proactivos: por hora y por día no pasan de su tope y respetan el horario activo', async () => {
      jest.useFakeTimers({ now: START });
      const rl = new BaileysRateLimiter('cap-camp', level);
      const sentAt: number[] = [];
      for (let i = 0; i < 400; i++) {
        void rl.enqueue(
          () => {
            sentAt.push(Date.now());
            return Promise.resolve({ success: true });
          },
          { maxAttempts: 1 },
        );
      }
      await jest.advanceTimersByTimeAsync(24 * HOUR);

      const perHour = maxIn(HOUR, sentAt);
      const firstDay = sentAt.filter((t) => t - START.getTime() < 24 * HOUR);
      console.log(
        `[capacidad] ${level} proactivos: ${perHour}/h máximo, ${firstDay.length} en 24 h`,
      );
      expect(perHour).toBeLessThanOrEqual(CAPS[level].campaignHour);
      expect(firstDay.length).toBeLessThanOrEqual(CAPS[level].campaignDay);
      for (const t of sentAt) {
        const hourBogota = (new Date(t).getUTCHours() + 24 - 5) % 24;
        expect(hourBogota).toBeGreaterThanOrEqual(8);
        expect(hourBogota).toBeLessThan(21);
      }
    });
  });
});
