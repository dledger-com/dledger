/**
 * Granted capabilities for browser plugins.
 * Mirrors src-tauri/src/plugin/capabilities.rs.
 */

export interface GrantedCapabilities {
  ledgerRead: boolean;
  ledgerWrite: boolean;
  http: boolean;
  allowedDomains: Set<string>;
  rateLimit: number;
}

export interface CapabilitiesDecl {
  ledger_read?: boolean;
  ledger_write?: boolean;
  http?: boolean;
  network?: {
    allowed_domains?: string[];
    rate_limit?: number;
  };
}

export function fromDeclaration(decl: CapabilitiesDecl): GrantedCapabilities {
  return {
    ledgerRead: decl.ledger_read ?? false,
    ledgerWrite: decl.ledger_write ?? false,
    http: decl.http ?? false,
    allowedDomains: new Set(decl.network?.allowed_domains ?? []),
    rateLimit: decl.network?.rate_limit ?? 30,
  };
}

export function isDomainAllowed(caps: GrantedCapabilities, url: string): boolean {
  if (!caps.http) return false;
  const host = extractHost(url);
  if (!host) return false;
  for (const d of caps.allowedDomains) {
    if (host === d || host.endsWith(`.${d}`)) return true;
  }
  return false;
}

function extractHost(url: string): string | null {
  const stripped = url.replace(/^https?:\/\//, "");
  const host = stripped.split("/")[0]?.split(":")[0];
  return host ? host.toLowerCase() : null;
}
