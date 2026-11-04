import * as path from 'path';

export const CONDUIT_ROOT = path.resolve(__dirname, '../..');
export const LEONICE_ROOT =
  process.env.BENCH_LEONICE_ROOT ??
  path.resolve(CONDUIT_ROOT, '../../leonice_spa_backend');

export const BENCH = {
  pgContainer: 'conduit-bench-pg',
  redisContainer: 'conduit-bench-redis',
  pgPort: Number(process.env.BENCH_PG_PORT ?? 55433),
  redisPort: Number(process.env.BENCH_REDIS_PORT ?? 56390),
  conduitPort: Number(process.env.BENCH_CONDUIT_PORT ?? 4931),
  leonicePort: Number(process.env.BENCH_LEONICE_PORT ?? 3931),
  pgPassword: 'bench',
  conduitDb: 'conduit_bench',
  leoniceDb: 'leonice_bench',
  leoniceRedisDb: 1,
  connections: Number(process.env.BENCH_CONNECTIONS ?? 4),
  budgetUsd: Number(process.env.BENCH_BUDGET_USD ?? 0.5),
  turnTimeoutMs: 150_000,
  sourceBotId: 'ea6cf0a6-15b2-42de-b4ff-988b8776b62d',
  priceUsdPerMTok: {
    input: 0.1,
    output: 0.5,
    cacheWrite: 0.125,
    cacheRead: 0.01,
  },
};

export const pgUrl = (db: string) =>
  `postgresql://postgres:${BENCH.pgPassword}@127.0.0.1:${BENCH.pgPort}/${db}`;

export const RESULTS_DIR =
  process.env.BENCH_RESULTS_DIR ?? path.join(__dirname, 'results');
