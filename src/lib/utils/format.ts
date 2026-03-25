import * as m from "$paraglide/messages.js";

let _locale: string = typeof navigator !== "undefined" ? navigator.language : "en-US";
const currencyFormatters = new Map<string, Intl.NumberFormat>();

export function setFormatLocale(locale: string) {
  _locale = locale;
  currencyFormatters.clear();
}

export function getFormatLocale(): string {
  return _locale;
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
