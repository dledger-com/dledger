import * as m from "$paraglide/messages.js";

let _locale: string = typeof navigator !== "undefined" ? navigator.language : "en-US";
const currencyFormatters = new Map<string, Intl.NumberFormat>();
let _groupSep = ",";
let _decimalSep = ".";

function refreshSeparators() {
  try {
    const parts = new Intl.NumberFormat(_locale).formatToParts(12345.6);
    _groupSep = parts.find((p) => p.type === "group")?.value ?? "";
    _decimalSep = parts.find((p) => p.type === "decimal")?.value ?? ".";
  } catch {
    _groupSep = ",";
    _decimalSep = ".";
  }
}
refreshSeparators();

export function setFormatLocale(locale: string) {
  _locale = locale;
  currencyFormatters.clear();
  refreshSeparators();
}

export function getFormatLocale(): string {
  return _locale;
}

/** Format a number using current locale conventions (no currency symbol). */
export function formatNumber(value: number | string, opts?: Intl.NumberFormatOptions): string {
  const n = typeof value === "string" ? parseFloat(value) : value;
  if (!isFinite(n)) return "";
  return new Intl.NumberFormat(_locale, opts).format(n);
}

/**
 * Parse a locale-formatted number string. Returns null if the input is
 * empty or cannot be parsed. Strips the locale's group separator (including
 * narrow no-break spaces used by fr-FR) and normalizes the decimal mark to ".".
 * Regular spaces are also stripped so users typing "45 000" still parse correctly.
 */
export function parseLocaleNumber(str: string): number | null {
  if (!str) return null;
  let s = str.trim();
  if (!s) return null;
  if (_groupSep) s = s.split(_groupSep).join("");
  s = s.replace(/\s/g, "");
  if (_decimalSep && _decimalSep !== ".") s = s.split(_decimalSep).join(".");
  const n = parseFloat(s);
  return isFinite(n) ? n : null;
}

export function formatCurrency(amount: string | number, currency = "USD"): string {
  let formatter = currencyFormatters.get(currency);
  if (!formatter) {
    try {
      formatter = new Intl.NumberFormat(_locale, {
        style: "currency",
        currency,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
    } catch {
      // Non-ISO currency code (e.g. AAPL, BTC) — use plain decimal format
      formatter = new Intl.NumberFormat(_locale, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
    }
    currencyFormatters.set(currency, formatter);
  }
  const num = typeof amount === "string" ? parseFloat(amount) : amount;
  const formatted = formatter.format(num);

  // If non-zero value rounds to zero display, expand precision
  if (num !== 0 && formatted === formatter.format(0)) {
    return formatWithExpandedPrecision(num, currency);
  }

  // If using the fallback (no currency symbol in output), append the code
  if (!/[^\d.,\s-]/.test(formatted)) {
    return `${formatted} ${currency}`;
  }
  return formatted;
}

function formatWithExpandedPrecision(num: number, currency: string): string {
  for (let digits = 3; digits <= 8; digits++) {
    let fmt: Intl.NumberFormat;
    try {
      fmt = new Intl.NumberFormat(_locale, {
        style: "currency",
        currency,
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      });
    } catch {
      fmt = new Intl.NumberFormat(_locale, {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      });
    }
    const result = fmt.format(num);
    if (result !== fmt.format(0)) {
      if (!/[^\d.,\s-]/.test(result)) {
        return `${result} ${currency}`;
      }
      return result;
    }
  }
  // Fallback: 8 digits wasn't enough, just return what we have
  const fallback = new Intl.NumberFormat(_locale, {
    minimumFractionDigits: 8,
    maximumFractionDigits: 8,
  }).format(num);
  return `${fallback} ${currency}`;
}

/**
 * Format a number using locale conventions, WITHOUT currency symbol or code.
 * Used for icon-based rendering where the icon replaces the currency symbol.
 */
export function formatAmountOnly(amount: string | number): string {
  const num = typeof amount === "string" ? parseFloat(amount) : amount;
  const formatter = new Intl.NumberFormat(_locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const formatted = formatter.format(num);
  // If non-zero rounds to zero, expand precision
  if (num !== 0 && formatted === formatter.format(0)) {
    for (let digits = 3; digits <= 8; digits++) {
      const f = new Intl.NumberFormat(_locale, { minimumFractionDigits: digits, maximumFractionDigits: digits });
      const r = f.format(num);
      if (r !== f.format(0)) return r;
    }
  }
  return formatted;
}

export function formatCurrencyFull(amount: string | number, currency = "USD"): string {
  const str = typeof amount === "number" ? String(amount) : amount;
  const num = parseFloat(str);
  // Derive precision from string representation
  const decimalPart = str.includes(".") ? (str.split(".")[1]?.replace(/0+$/, "") ?? "") : "";
  const digits = Math.min(Math.max(2, decimalPart.length), 20);

  let formatter: Intl.NumberFormat;
  try {
    formatter = new Intl.NumberFormat(_locale, {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: digits,
    });
  } catch {
    formatter = new Intl.NumberFormat(_locale, {
      minimumFractionDigits: 2,
      maximumFractionDigits: digits,
    });
  }

  const formatted = formatter.format(num);
  if (!/[^\d.,\s-]/.test(formatted)) {
    return `${formatted} ${currency}`;
  }
  return formatted;
}

/** Negate a string amount for credit-normal display (revenue, liability, equity). */
export function negateAmount(amount: string): string {
  const n = parseFloat(amount);
  return (n === 0 ? 0 : -n).toString();
}

/** Negate all amounts in a CurrencyBalance array for credit-normal display. */
export function negateCurrencyBalances<T extends { currency: string; amount: string }>(
  balances: T[],
): T[] {
  return balances.map((b) => ({ ...b, amount: negateAmount(b.amount) }));
}

export function formatDate(dateStr: string, format = "YYYY-MM-DD"): string {
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return dateStr;

  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");

  switch (format) {
    case "MM/DD/YYYY":
      return `${m}/${d}/${y}`;
    case "DD/MM/YYYY":
      return `${d}/${m}/${y}`;
    case "YYYY-MM-DD":
    default:
      return `${y}-${m}-${d}`;
  }
}

export function formatDateRelative(dateStr: string): string {
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return dateStr;

  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return m.date_today();
  if (diffDays === 1) return m.date_yesterday();
  if (diffDays < 7) return m.date_days_ago({ count: diffDays });
  if (diffDays < 30) return m.date_weeks_ago({ count: Math.floor(diffDays / 7) });
  return formatDate(dateStr);
}
