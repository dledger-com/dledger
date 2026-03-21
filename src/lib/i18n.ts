/**
 * i18n initialization for dledger.
 *
 * Call `initLocale()` once at app startup (before rendering)
 * to configure paraglide's locale resolution from AppSettings.
 */
import {
  overwriteGetLocale,
  overwriteSetLocale,
  baseLocale,
  type Locale,
} from "$paraglide/runtime.js";
import { setFormatLocale } from "$lib/utils/format.js";

/** Map a BCP-47 locale string to a supported paraglide locale tag. */
function toSupportedLocale(locale: string): Locale {
  if (locale.startsWith("fr")) return "fr" as Locale;
  return baseLocale as Locale;
}

let _currentLocale: Locale = baseLocale as Locale;

/**
 * Initialize the paraglide locale from a stored locale value.
 * Must be called before any message functions are invoked.
 */
export function initLocale(savedLocale?: string): void {
  const effectiveLocale =
    savedLocale ??
    (typeof navigator !== "undefined" ? navigator.language : "en-US");
  _currentLocale = toSupportedLocale(effectiveLocale);

  overwriteGetLocale(() => _currentLocale);

  overwriteSetLocale((newLocale: Locale) => {
    _currentLocale = newLocale;
    // Also update Intl number/date formatting locale
    setFormatLocale(newLocale === "fr" ? "fr-FR" : "en-US");
    // Reload to apply new locale across all components
    window.location.reload();
  });

  // Sync the format locale too
  setFormatLocale(
    effectiveLocale === "auto" || !effectiveLocale
      ? (typeof navigator !== "undefined" ? navigator.language : "en-US")
      : effectiveLocale,
  );
}

export function getCurrentLocale(): Locale {
  return _currentLocale;
}
