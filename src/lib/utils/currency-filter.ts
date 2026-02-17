import type {
  JournalEntry,
  LineItem,
  CurrencyBalance,
  TrialBalanceLine,
  GainLossLine,
} from "$lib/types/index.js";

export function entryInvolvesHidden(
  items: LineItem[],
  hidden: Set<string>,
): boolean {
  return items.some((item) => hidden.has(item.currency));
}

export function filterHiddenEntries(
  entries: [JournalEntry, LineItem[]][],
  hidden: Set<string>,
): [JournalEntry, LineItem[]][] {
  if (hidden.size === 0) return entries;
  return entries.filter(([, items]) => !entryInvolvesHidden(items, hidden));
}

export function filterHiddenBalances(
  balances: CurrencyBalance[],
  hidden: Set<string>,
): CurrencyBalance[] {
  if (hidden.size === 0) return balances;
  return balances.filter((b) => !hidden.has(b.currency));
}

export function filterHiddenTrialLines(
  lines: TrialBalanceLine[],
  hidden: Set<string>,
): TrialBalanceLine[] {
  if (hidden.size === 0) return lines;
  return lines
    .map((line) => ({
      ...line,
      balances: line.balances.filter((b) => !hidden.has(b.currency)),
    }))
    .filter((line) => line.balances.length > 0);
}

export function filterHiddenGainLoss(
  lines: GainLossLine[],
  hidden: Set<string>,
): GainLossLine[] {
  if (hidden.size === 0) return lines;
  return lines.filter((line) => !hidden.has(line.currency));
}
