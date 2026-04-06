# dledger

A personal double-entry ledger for tracking finances across bank accounts, crypto exchanges, DeFi protocols, and wallets. Runs as a native desktop app (Tauri) or in the browser (sql.js + OPFS).

## Features

- **Double-entry bookkeeping** with multi-currency support and configurable account paths
- **Crypto integrations** -- Etherscan, 13 DeFi protocol handlers, 7 CEX adapters (Kraken, Binance, Coinbase, Bybit, OKX, Bitstamp, Crypto.com), and chain-specific wallets (Bitcoin, Solana, Sui, Aptos, TON, and more)
- **Bank imports** -- CSV (18 presets with auto-detection), OFX/QFX/QBO, and PDF statement parsing (N26, La Banque Postale, Nuri, Deblock)
- **Exchange rates** -- automatic sync from 7 sources (Frankfurter, CoinGecko, DefiLlama, Finnhub, CryptoCompare, Binance, dprice)
- **Reports** -- dashboard, balance sheet, journal, budgets, and French tax reports (plus 3916-bis)
- **ML classification** -- in-browser transaction categorization via Transformers.js (opt-in)
- **i18n** -- English and French via Paraglide JS
- **Plugin system** -- extensible handlers, CSV presets, PDF parsers, CEX adapters, and rate sources

## Tech Stack

| Layer | Technology |
|-------|------------|
| Desktop shell | Tauri v2 (Rust) |
| Frontend | SvelteKit (SPA), Svelte 5, TypeScript |
| UI | shadcn-svelte, Tailwind v4, Lucide icons |
| Charts | LayerChart (d3) |
| Database | rusqlite (Tauri) / sql.js WASM + OPFS (browser) |
| JS runtime | Bun |
| Dev environment | Nix flakes (direnv) |
| Testing | Vitest, Playwright (E2E), Cargo test |

## Getting Started

### Prerequisites

- [Nix](https://nixos.org/) with flakes enabled (provides Rust, Bun, and system deps)

### Setup

```sh
# Enter the dev shell (automatic with direnv)
nix develop

# Install frontend dependencies
bun install
```

### Development

```sh
bun run tauri dev       # Launch desktop app in dev mode
```

### Build

```sh
bun run tauri build     # Production build
```

### Tests

```sh
bun run test            # Vitest (frontend + backend logic)
bun run e2e             # Playwright E2E tests
cargo test --manifest-path src-tauri/Cargo.toml   # Rust tests
```

### Type Checking

```sh
bun run check           # One-shot
bun run check:watch     # Watch mode
```

## Project Structure

```
src/                    SvelteKit frontend (SPA, SSR disabled)
  routes/(app)/         Pages: dashboard, journal, accounts, currencies,
                        sources, reports, budgets, settings
  lib/                  Core logic, backend interface, handlers, CEX adapters,
                        CSV/OFX/PDF import, ML classification, plugins
src-tauri/              Tauri v2 Rust backend, commands, dprice integration
crates/
  dledger-core/         Pure Rust library (shared logic)
  dsample/              Sample data generator
messages/               i18n message files (en.json, fr.json)
e2e/                    Playwright E2E tests
```

## License

MIT
