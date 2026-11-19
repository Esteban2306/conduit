const SLOT_TIME =
  /\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s?m\.?(?=\s|$|[^a-z])/gi;

export function proposedSlotTimes(text: string): string[] {
  const times = new Set<string>();
  for (const match of text.matchAll(SLOT_TIME)) {
    times.add(
      `${Number(match[1])}:${match[2] ?? '00'}${match[3].toLowerCase()}`,
    );
  }
  return [...times];
}

export const proposesSingleSlot = (text: string): boolean =>
  proposedSlotTimes(text).length === 1;

export const proposesSeveralSlots = (text: string): boolean =>
  proposedSlotTimes(text).length > 1;
