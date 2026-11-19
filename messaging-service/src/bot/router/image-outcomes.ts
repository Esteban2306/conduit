import { IMAGE_ANALYSIS_CAPABILITY } from '../specialists/constants';

interface CapabilityVerdict {
  capability: string;
  result: { verdict: string };
}

function primaryOutcomes<T extends CapabilityVerdict>(
  outcomes: readonly T[],
): T[] {
  const receipts = outcomes.filter(
    (outcome) => outcome.capability === IMAGE_ANALYSIS_CAPABILITY,
  );
  return receipts.length > 0 ? receipts : [...outcomes];
}

export function shownOutcomes<T extends CapabilityVerdict>(
  outcomes: readonly T[],
): T[] {
  const applicable = outcomes.filter(
    (outcome) => outcome.result.verdict !== 'NOT_APPLICABLE',
  );
  return applicable.length > 0 ? applicable : primaryOutcomes(outcomes);
}
