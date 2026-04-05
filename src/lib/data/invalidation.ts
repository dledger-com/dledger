/**
 * Global invalidation bus for cross-store and cross-tab data freshness.
 *
 * Stores emit invalidation signals after mutations. Pages subscribe
 * to the signals they care about and re-fetch their local data.
 * A BroadcastChannel relays signals to other browser tabs.
 */

export type InvalidationKind = "journal" | "accounts" | "currencies" | "reports" | "plugins";

type Listener = () => void;

const listeners = new Map<InvalidationKind, Set<Listener>>();

/**
 * Subscribe to invalidation signals for a given kind.
 * Returns an unsubscribe function (call it in onDestroy / cleanup).
 */
export function onInvalidate(kind: InvalidationKind, listener: Listener): () => void {
  let set = listeners.get(kind);
  if (!set) {
    set = new Set();
    listeners.set(kind, set);
  }
  set.add(listener);
  return () => set.delete(listener);
}

/**
 * Emit invalidation for the given kinds — notifies local subscribers
 * and broadcasts to other tabs.
 */
export function invalidate(...kinds: InvalidationKind[]): void {
  for (const kind of kinds) {
    listeners.get(kind)?.forEach((fn) => fn());
  }
  channel?.postMessage({ kinds });
}

// ── BroadcastChannel (cross-tab) ──────────────────────────────────

let channel: BroadcastChannel | null = null;

/**
 * Initialise the cross-tab invalidation channel.
 * Call once from the root layout's onMount.
 */
export function initInvalidationChannel(): void {
  if (channel) return;
  try {
    channel = new BroadcastChannel("dledger-invalidation");
    channel.onmessage = (event: MessageEvent<{ kinds: InvalidationKind[] }>) => {
      // Fire local listeners but do NOT re-broadcast (avoids infinite loop)
      for (const kind of event.data.kinds) {
        listeners.get(kind)?.forEach((fn) => fn());
      }
    };
  } catch {
    // BroadcastChannel not available (e.g. Tauri webview on some platforms)
  }
}

/**
 * Tear down the cross-tab channel.
 * Call from the root layout cleanup / pagehide.
 */
export function disposeInvalidationChannel(): void {
  channel?.close();
  channel = null;
}
