import { ContextSource, RulesDocument } from './contracts';

const PREFIX = 'grounding.';

export function referencedGroundingKeys(rules: RulesDocument): Set<string> {
  const keys = new Set<string>();
  for (const rule of rules.rules) {
    if (typeof rule.ref === 'string' && rule.ref.startsWith(PREFIX)) {
      keys.add(rule.ref.slice(PREFIX.length));
    }
  }
  return keys;
}

export function undeclaredGroundingKeys(
  rules: RulesDocument,
  sources: readonly ContextSource[],
): string[] {
  const declared = new Set(sources.map((source) => source.key));
  return [...referencedGroundingKeys(rules)].filter(
    (key) => !declared.has(key),
  );
}
