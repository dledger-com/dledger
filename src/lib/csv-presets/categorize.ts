export interface CsvCategorizationRule {
  id: string;
  pattern: string;   // substring match (case-insensitive)
  account: string;   // target account path
}

export function matchRule(
  description: string,
  rules: CsvCategorizationRule[],
): CsvCategorizationRule | null {
  if (!description) return null;
  const lower = description.toLowerCase();
  for (const rule of rules) {
    if (rule.pattern && lower.includes(rule.pattern.toLowerCase())) {
      return rule;
    }
  }
  return null;
}
