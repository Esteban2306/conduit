import type { CacheStore } from '@whiskeysockets/baileys';

/**
 * CacheStore en memoria con expiración, para los cachés que Baileys pide
 * por socket (p. ej. `msgRetryCounterCache`, que limita cuántas veces se
 * reintenta descifrar un mismo mensaje). Debe vivir más que el socket:
 * si se recrea en cada reconexión, el contador se reinicia y un mensaje
 * problemático puede generar reintentos sin fin.
 */
export class TtlCacheStore implements CacheStore {
  private readonly entries = new Map<
    string,
    { value: unknown; expiresAt: number }
  >();

  constructor(private readonly ttlMs: number) {}

  get<T>(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  set<T>(key: string, value: T): void {
    this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    if (this.entries.size % 500 === 0) this.prune();
  }

  del(key: string): void {
    this.entries.delete(key);
  }

  flushAll(): void {
    this.entries.clear();
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (now > entry.expiresAt) this.entries.delete(key);
    }
  }
}
