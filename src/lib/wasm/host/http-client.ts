/**
 * Browser host implementation for the WIT http-client interface.
 * Uses synchronous XMLHttpRequest to avoid JSPI memory corruption.
 * Mirrors src-tauri/src/plugin/host_impl.rs http_client::Host.
 *
 * NOTE: Synchronous XHR briefly blocks the UI during the request.
 * This is an acceptable trade-off vs JSPI "memory access out of bounds".
 *
 * Browser requests may hit CORS restrictions. A CORS proxy
 * can be configured via the corsProxyUrl parameter.
 */

import type { HttpClientImports, HttpRequest, HttpResponse } from "./types.js";
import { isDomainAllowed, type GrantedCapabilities } from "./capabilities.js";

/**
 * Create a synchronous http-client host import object for a source plugin.
 * Uses XMLHttpRequest in sync mode — no JSPI needed.
 */
export function createSyncHttpClient(
  caps: GrantedCapabilities,
  pluginName: string,
  corsProxyUrl?: string,
): HttpClientImports {
  let lastRequestTime = 0;
  const minInterval = caps.rateLimit > 0 ? 1000 / caps.rateLimit : 0;

  return {
    send(request: HttpRequest): HttpResponse {
      // Check HTTP capability
      if (!caps.http) {
        throw "permission-denied";
      }

      // Check domain allowlist
      if (!isDomainAllowed(caps, request.url)) {
        console.warn(`[plugin:${pluginName}] Domain not in allowlist: ${request.url}`);
        throw "domain-not-allowed";
      }

      // Simple rate limiting via busy-wait (short durations only)
      const now = Date.now();
      const elapsed = now - lastRequestTime;
      if (elapsed < minInterval) {
        const target = lastRequestTime + minInterval;
        while (Date.now() < target) {
          /* spin */
        }
      }
      lastRequestTime = Date.now();

      // Optionally rewrite URL through CORS proxy
      let url = request.url;
      if (corsProxyUrl) {
        url = `${corsProxyUrl}/${url}`;
      }

      try {
        const xhr = new XMLHttpRequest();
        xhr.open(request.method, url, false); // false = synchronous

        for (const [key, value] of request.headers) {
          xhr.setRequestHeader(key, value);
        }

        // Sync XHR doesn't support responseType "arraybuffer",
        // so we get text and convert to bytes
        xhr.overrideMimeType("text/plain; charset=x-user-defined");

        if (request.body.length > 0) {
          xhr.send(request.body);
        } else {
          xhr.send();
        }

        // Parse response headers
        const responseHeaders: [string, string][] = [];
        const headerStr = xhr.getAllResponseHeaders();
        for (const line of headerStr.split("\r\n")) {
          const idx = line.indexOf(":");
          if (idx > 0) {
            responseHeaders.push([
              line.slice(0, idx).trim(),
              line.slice(idx + 1).trim(),
            ]);
          }
        }

        // Convert response text to bytes
        // x-user-defined charset gives us raw bytes in charCodeAt()
        const text = xhr.responseText;
        const body = new Uint8Array(text.length);
        for (let i = 0; i < text.length; i++) {
          body[i] = text.charCodeAt(i) & 0xff;
        }

        return {
          status: xhr.status,
          headers: responseHeaders,
          body,
        };
      } catch (e) {
        console.error(`[plugin:${pluginName}] HTTP request failed:`, e);
        throw "network-error";
      }
    },
  };
}
