/**
 * Shared fetch utility for CEX adapters.
 * - Tauri mode: uses the proxy_fetch Rust command (ureq, no CORS)
 * - Browser mode: rewrites baseUrl → proxyPrefix for Vite dev proxy
 */
export async function cexFetch(
  url: string,
  baseUrl: string,
  proxyPrefix: string,
  init?: RequestInit,
  signal?: AbortSignal,
): Promise<{ status: number; body: string }> {
  if ((window as any).__TAURI_INTERNALS__) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke("proxy_fetch", {
      url,
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === "string" ? init.body : null,
    });
  }
  // Browser mode: rewrite URL to use Vite proxy
  const proxyUrl = url.replace(baseUrl, proxyPrefix);
  const resp = await fetch(proxyUrl, { ...init, signal });
  return { status: resp.status, body: await resp.text() };
}

export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}
