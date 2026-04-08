// Build-time demo mode flag.
// Set VITE_DEMO_MODE=true at build time to produce a read-only demo bundle
// pre-loaded with sample data and with all mutation surfaces removed.
// Vite inlines this constant so `if (DEMO_MODE)` branches dead-code-eliminate
// when the flag is false. Always import this constant rather than reading
// `import.meta.env.VITE_DEMO_MODE` directly.

export const DEMO_MODE: boolean = import.meta.env.VITE_DEMO_MODE === "true";
