import { toast } from "svelte-sonner";
import { goto } from "$app/navigation";

/**
 * Show a toast listing auto-hidden currencies with a "Review in Settings" action.
 * Lists up to 5 currencies, then "and N more".
 */
export function showAutoHideToast(currencies: string[]): void {
  if (currencies.length === 0) return;

  const MAX_SHOWN = 5;
  const shown = currencies.slice(0, MAX_SHOWN);
  const remaining = currencies.length - shown.length;

  let message = `Auto-hid ${currencies.length} currency(ies): ${shown.join(", ")}`;
  if (remaining > 0) {
    message += ` and ${remaining} more`;
  }

  toast.info(message, {
    duration: 8000,
    action: {
      label: "Review in Settings",
      onClick: () => goto("/settings"),
    },
  });
}
