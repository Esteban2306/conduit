export interface IsolatedInfra {
  redis: { host: string; port: number; password?: string };
  databaseUrl: string;
}

const SHARED_REDIS_PORT = 6379;

export function isolatedInfra(
  env: NodeJS.ProcessEnv = process.env,
): IsolatedInfra | null {
  const port = Number(env.TEST_REDIS_PORT ?? 0);
  const databaseUrl = env.TEST_DATABASE_URL ?? '';

  if (!Number.isInteger(port) || port <= 0 || port === SHARED_REDIS_PORT) {
    return null;
  }
  if (
    !databaseUrl ||
    !databaseName(databaseUrl).toLowerCase().includes('test')
  ) {
    return null;
  }

  return {
    redis: {
      host: env.TEST_REDIS_HOST || '127.0.0.1',
      port,
      password: env.TEST_REDIS_PASSWORD || undefined,
    },
    databaseUrl,
  };
}

function databaseName(url: string): string {
  try {
    return new URL(url).pathname.replace(/^\//, '');
  } catch {
    return '';
  }
}
