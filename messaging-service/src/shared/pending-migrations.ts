import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface MigrationLedger {
  applied: string[];
  onDisk: string[];
}

export function pendingMigrations({
  applied,
  onDisk,
}: MigrationLedger): string[] {
  const done = new Set(applied);
  return onDisk.filter((name) => !done.has(name)).sort();
}

export function migrationsOnDisk(root: string = process.cwd()): string[] {
  const dir = join(root, 'prisma', 'migrations');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}
