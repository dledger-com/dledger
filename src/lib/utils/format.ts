const currencyFormatters = new Map<string, Intl.NumberFormat>();

export function formatCurrency(amount: string | number, currency = "USD"): string {
  let formatter = currencyFormatters.get(currency);
  if (!formatter) {
    try {
      formatter = new Intl.NumberFormat("en-US", {
        style: "currency",
        currency,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
    } catch {
      // Non-ISO currency code (e.g. AAPL, BTC) — use plain decimal format
      formatter = new Intl.NumberFormat("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
    }
    currencyFormatters.set(currency, formatter);
  }
  const num = typeof amount === "string" ? parseFloat(amount) : amount;
  const formatted = formatter.format(num);
  // If using the fallback (no currency symbol in output), append the code
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

  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays} days ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)} weeks ago`;
  return formatDate(dateStr);
}
