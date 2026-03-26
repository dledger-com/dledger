// Collect system information for bug reports.

declare const __APP_VERSION__: string;

export function getSystemInfo(): string {
  const lines: string[] = [];
  lines.push(`dLedger version: v${__APP_VERSION__}`);
  lines.push(`Platform: ${navigator.platform}`);
  lines.push(`User agent: ${navigator.userAgent}`);
  lines.push(`Viewport: ${window.innerWidth}x${window.innerHeight}`);
  lines.push(`Language: ${navigator.language}`);
  return lines.join("\n");
}
