import { toast } from "svelte-sonner";
import { goto } from "$app/navigation";
import * as m from "$paraglide/messages.js";

/**
 * Show a toast listing auto-hidden currencies with a "Review in Settings" action.
 * Lists up to 5 currencies, then "and N more".
 */
export function showAutoHideToast(currencies: string[]): void {
  if (currencies.length === 0) return;

  const MAX_SHOWN = 5;
  const shown = currencies.slice(0, MAX_SHOWN);
  const remaining = currencies.length - shown.length;

  const base = m.toast_auto_hid_currencies({ count: String(currencies.length), list: shown.join(", ") });
  const suffix = remaining > 0 ? m.toast_auto_hid_and_more({ count: String(remaining) }) : "";

  toast.info(`${base}${suffix}`, {
    duration: 8000,
    action: {
      label: m.toast_review_in_settings(),
      onClick: () => goto("/settings"),
    },
  });
}
