import type { ActionMemoryEntry } from './ConversationService';

export const PINNED_MEMORY_KEY = 'memoriaFija';
export const MAX_PINNED_MEMORY = 4;

export function pinnedEntriesOf(value: unknown): ActionMemoryEntry[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.values(value as Record<string, unknown>).filter(
    (entry): entry is ActionMemoryEntry =>
      !!entry &&
      typeof entry === 'object' &&
      typeof (entry as ActionMemoryEntry).herramienta === 'string' &&
      typeof (entry as ActionMemoryEntry).resultado === 'string' &&
      typeof (entry as ActionMemoryEntry).en === 'string',
  );
}

export function pinEntry(
  current: unknown,
  entry: ActionMemoryEntry,
): Record<string, ActionMemoryEntry> {
  const kept = pinnedEntriesOf(current)
    .filter((e) => e.herramienta !== entry.herramienta)
    .sort((a, b) => a.en.localeCompare(b.en))
    .slice(-(MAX_PINNED_MEMORY - 1));
  return Object.fromEntries([...kept, entry].map((e) => [e.herramienta, e]));
}
