import * as fs from 'fs';
import * as path from 'path';

export const DISABLED = 'bench-disabled';

export function envFileKeys(root: string): string[] {
  const file = path.join(root, '.env');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1])
    .filter((key): key is string => Boolean(key));
}

export function isolatedEnv(
  root: string,
  overrides: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    TZ: 'America/Bogota',
  };
  for (const key of envFileKeys(root)) env[key] = DISABLED;
  return { ...env, ...overrides };
}

export function applyToProcess(env: Record<string, string>): void {
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
}
