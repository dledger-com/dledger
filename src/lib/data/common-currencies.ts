/** Common fiat currencies shown in base currency selectors (onboarding + settings). */
export const COMMON_CURRENCIES = [
  { code: "EUR", name: "Euro" },
  { code: "USD", name: "US Dollar" },
  { code: "GBP", name: "British Pound" },
  { code: "CHF", name: "Swiss Franc" },
  { code: "CAD", name: "Canadian Dollar" },
  { code: "AUD", name: "Australian Dollar" },
  { code: "JPY", name: "Japanese Yen" },
  { code: "CNY", name: "Chinese Yuan" },
] as const;

/** Map ISO 3166-1 alpha-2 region codes to their primary currency. */
const REGION_CURRENCY: Record<string, string> = {
  // Eurozone
  AT: "EUR", BE: "EUR", CY: "EUR", DE: "EUR", EE: "EUR", ES: "EUR",
  FI: "EUR", FR: "EUR", GR: "EUR", HR: "EUR", IE: "EUR", IT: "EUR",
  LT: "EUR", LU: "EUR", LV: "EUR", MT: "EUR", NL: "EUR", PT: "EUR",
  SI: "EUR", SK: "EUR",
  // Others in COMMON_CURRENCIES
  US: "USD", GB: "GBP", CH: "CHF", LI: "CHF",
  CA: "CAD", AU: "AUD", JP: "JPY", CN: "CNY",
};

/**
 * Infer the most likely base currency from the user's browser locale.
 * Extracts the region from `navigator.language` and maps it to a currency
 * from `COMMON_CURRENCIES`. Falls back to USD if the region is unknown.
 */
export function currencyForLocale(locale?: string): string {
  const tag = locale ?? (typeof navigator !== "undefined" ? navigator.language : "en-US");
  let region: string | undefined;
  try {
    region = new Intl.Locale(tag).region?.toUpperCase();
  } catch {
    const parts = tag.split("-");
    if (parts.length > 1) region = parts[parts.length - 1].toUpperCase();
  }
  if (!region) return "USD";
  return REGION_CURRENCY[region] ?? "USD";
}
