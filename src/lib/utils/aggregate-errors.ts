export interface AggregatedError {
  /** Summary message, e.g. "CoinGecko: no rate for 47 currencies: JUNK1, JUNK2, ..." */
  message: string;
  /** Number of individual errors in this group */
  count: number;
}

/**
 * Groups errors by pattern (source + error type), collapsing per-currency errors
 * into summaries. For example:
 *   "CoinGecko: no rate for JUNK1" x 50 → "CoinGecko: no rate for 50 currencies: JUNK1, JUNK2, ..."
 */
export function aggregateErrors(errors: string[]): AggregatedError[] {
  if (errors.length === 0) return [];

  // Try to match patterns like "<Source>: <message> <CURRENCY>"
  // Common patterns:
  //   "CoinGecko: no rate for JUNK1"
  //   "Frankfurter: no rate for XYZ"
  //   "Finnhub: no rate for ABC"
  //   "CoinGecko: API error for TOKEN"
  const patternRegex = /^(.+?):\s+(.+?)\s+(\S+)$/;

  const groups = new Map<string, string[]>();
  const ungrouped: string[] = [];

  for (const error of errors) {
    const match = error.match(patternRegex);
    if (match) {
      const [, source, messageBody, currency] = match;
      const key = `${source}: ${messageBody}`;
      let list = groups.get(key);
      if (!list) {
        list = [];
        groups.set(key, list);
      }
      list.push(currency);
    } else {
      ungrouped.push(error);
    }
  }

  const result: AggregatedError[] = [];

  for (const [pattern, currencies] of groups) {
    if (currencies.length === 1) {
      result.push({ message: `${pattern} ${currencies[0]}`, count: 1 });
    } else {
      const MAX_SHOWN = 5;
      const shown = currencies.slice(0, MAX_SHOWN);
      const remaining = currencies.length - shown.length;
      let list = shown.join(", ");
      if (remaining > 0) {
        list += `, and ${remaining} more`;
      }
      result.push({
        message: `${pattern} ${currencies.length} currencies: ${list}`,
        count: currencies.length,
      });
    }
  }

  // Group identical ungrouped errors
  const ungroupedCounts = new Map<string, number>();
  for (const error of ungrouped) {
    ungroupedCounts.set(error, (ungroupedCounts.get(error) ?? 0) + 1);
  }
  for (const [error, count] of ungroupedCounts) {
    if (count === 1) {
      result.push({ message: error, count: 1 });
    } else {
      result.push({ message: `${error} (x${count})`, count });
    }
  }

  return result;
}
