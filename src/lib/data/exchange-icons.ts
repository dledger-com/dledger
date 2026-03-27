import { INSTITUTION_REGISTRY } from "$lib/cex/institution-registry.js";

/**
 * Get the icon URL for an exchange. Uses Google Favicons derived from the
 * institution registry's website URL.
 */
export function getExchangeIconUrl(exchangeId: string): string | null {
  const info = INSTITUTION_REGISTRY[exchangeId];
  if (info?.url) return `https://www.google.com/s2/favicons?domain=${info.url}&sz=32`;
  return null;
}
