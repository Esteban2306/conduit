import { execFileSync, ExecFileSyncOptions } from 'child_process';
import * as path from 'path';
import { BENCH, CONDUIT_ROOT, LEONICE_ROOT, pgUrl } from './bench.config';
import { isolatedEnv } from './isolated-env';

const run = (cmd: string, args: string[], opts: ExecFileSyncOptions = {}) =>
  execFileSync(cmd, args, {
    stdio: 'pipe',
    encoding: 'utf8',
    ...opts,
  }) as unknown as string;

const containerState = (name: string): string | null => {
  try {
    return run('docker', ['inspect', '-f', '{{.State.Status}}', name]).trim();
  } catch {
    return null;
  }
};

function ensureContainer(name: string, args: string[]): void {
  const state = containerState(name);
  if (state === 'running') return;
  if (state) run('docker', ['start', name]);
  else run('docker', ['run', '-d', '--name', name, ...args]);
}

async function waitFor(
  check: () => boolean,
  label: string,
  timeoutMs = 60_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${label} no respondió a tiempo`);
}

const psql = (sql: string) =>
  run('docker', [
    'exec',
    BENCH.pgContainer,
    'psql',
    '-U',
    'postgres',
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    sql,
  ]);

export async function prepareInfra(log: (m: string) => void): Promise<void> {
  ensureContainer(BENCH.pgContainer, [
    '-p',
    `127.0.0.1:${BENCH.pgPort}:5432`,
    '-e',
    `POSTGRES_PASSWORD=${BENCH.pgPassword}`,
    'postgres:16-alpine',
  ]);
  ensureContainer(BENCH.redisContainer, [
    '-p',
    `127.0.0.1:${BENCH.redisPort}:6379`,
    'redis:7-alpine',
  ]);
  await waitFor(() => {
    try {
      run('docker', [
        'exec',
        BENCH.pgContainer,
        'pg_isready',
        '-U',
        'postgres',
      ]);
      psql('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }, 'Postgres de pruebas');
  await waitFor(() => {
    try {
      return run('docker', [
        'exec',
        BENCH.redisContainer,
        'redis-cli',
        'ping',
      ]).includes('PONG');
    } catch {
      return false;
    }
  }, 'Redis de pruebas');
  log(
    `Contenedores listos: ${BENCH.pgContainer}:${BENCH.pgPort}, ${BENCH.redisContainer}:${BENCH.redisPort}`,
  );

  for (const db of [BENCH.conduitDb, BENCH.leoniceDb]) {
    psql(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    psql(`CREATE DATABASE ${db}`);
  }
  run('docker', ['exec', BENCH.redisContainer, 'redis-cli', 'FLUSHALL']);
  log('Bases conduit_bench y leonice_bench recreadas; Redis de pruebas vacío');

  run(
    path.join(CONDUIT_ROOT, 'node_modules/.bin/prisma'),
    ['migrate', 'deploy'],
    {
      cwd: CONDUIT_ROOT,
      env: isolatedEnv(CONDUIT_ROOT, { DATABASE_URL: pgUrl(BENCH.conduitDb) }),
    },
  );
  log('Migraciones de Conduit aplicadas');

  run(
    path.join(LEONICE_ROOT, 'node_modules/.bin/prisma'),
    ['migrate', 'deploy'],
    {
      cwd: LEONICE_ROOT,
      env: isolatedEnv(LEONICE_ROOT, { DATABASE_URL: pgUrl(BENCH.leoniceDb) }),
    },
  );
  log('Migraciones de Leonice aplicadas');

  const tsNode = path.join(LEONICE_ROOT, 'node_modules/.bin/ts-node');
  const seedEnv = isolatedEnv(LEONICE_ROOT, {
    DATABASE_URL: pgUrl(BENCH.leoniceDb),
    REDIS_URL: `redis://127.0.0.1:${BENCH.redisPort}/${BENCH.leoniceRedisDb}`,
    CONDUIT_BASE_URL: '',
    CONDUIT_API_KEY: '',
    SEED_ADMIN_EMAIL: 'bench-admin@leonice.test',
    SEED_ADMIN_PASSWORD: 'Bench-Admin-Password-2026!',
    NODE_ENV: 'development',
    TS_NODE_TRANSPILE_ONLY: 'true',
    TS_NODE_COMPILER_OPTIONS:
      '{"module":"commonjs","moduleResolution":"node","resolvePackageJsonExports":false}',
  });
  run(tsNode, ['prisma/seed.ts'], { cwd: LEONICE_ROOT, env: seedEnv });
  run(tsNode, ['prisma/seed-treatment-content.ts'], {
    cwd: LEONICE_ROOT,
    env: seedEnv,
  });
  log('Catálogo de Leonice sembrado (seed.ts + seed-treatment-content.ts)');
}

export function stopInfraHint(): string {
  return `docker rm -f ${BENCH.pgContainer} ${BENCH.redisContainer}`;
}
