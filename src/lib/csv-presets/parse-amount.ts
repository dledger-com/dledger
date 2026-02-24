// Detect whether a set of number strings use European format (dot=thousands, comma=decimal)
export function detectNumberFormat(sampleValues: string[]): { european: boolean } {
  let europeanVotes = 0;
  let standardVotes = 0;

  for (const raw of sampleValues) {
    const v = raw.trim().replace(/^[($€£¥-]+/, "").replace(/[)]+$/, "");
    if (!v) continue;

    // Pattern: "1.234,56" — dot before comma → European
    if (/\d\.\d{3},\d{1,2}$/.test(v)) {
      europeanVotes++;
      continue;
    }
    // Pattern: "1,234.56" — comma before dot → Standard
    if (/\d,\d{3}\.\d{1,2}$/.test(v)) {
      standardVotes++;
      continue;
    }
    // Pattern: "1.234" could be European thousands or standard decimal
    // Pattern: "1,234" could be standard thousands or European decimal
    // Single comma with 2 decimals: "123,45" → European
    if (/^\d+,\d{2}$/.test(v)) {
      europeanVotes++;
      continue;
    }
    // Single dot with 2 decimals and no comma: "123.45" → Standard (or ambiguous)
    if (/^\d+\.\d{2}$/.test(v)) {
      standardVotes++;
      continue;
    }
  }

  return { european: europeanVotes > standardVotes };
}

export function parseAmount(raw: string, europeanFormat = false): number | null {
  let v = raw.trim();
  if (!v) return null;

  // Detect parentheses for negatives: (100.00) → -100
  const isParenNeg = v.startsWith("(") && v.endsWith(")");
  if (isParenNeg) {
    v = v.slice(1, -1).trim();
  }

  // Detect leading minus
  const isNeg = v.startsWith("-");
  if (isNeg) {
    v = v.slice(1).trim();
  }

  // Strip currency symbols and whitespace
  v = v.replace(/^[A-Z]{2,4}\s*/i, ""); // "EUR 100" → "100"
  v = v.replace(/[$€£¥₹₿\s]/g, "");

  if (!v) return null;

  if (europeanFormat) {
    // European: dots are thousands separators, comma is decimal
    v = v.replace(/\./g, "");  // remove thousands dots
    v = v.replace(",", ".");   // convert decimal comma to dot
  } else {
    // Standard: commas are thousands separators, dot is decimal
    v = v.replace(/,/g, "");   // remove thousands commas
    // Also handle space as thousands separator: "1 234.56"
    v = v.replace(/ /g, "");
  }

  const num = parseFloat(v);
  if (!Number.isFinite(num)) return null;

  return (isNeg || isParenNeg) ? -num : num;
}
