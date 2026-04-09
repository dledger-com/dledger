<p align="center">
  <img src="static/dledger-logo-48px.webp" alt="dledger" width="48" height="48">
</p>

<h1 align="center">dledger</h1>

<p align="center">
  A personal double-entry ledger for tracking finances across bank accounts,<br>
  crypto exchanges, DeFi protocols, and wallets.<br>
  Runs as a native desktop app (Tauri) or in the browser.
</p>

<p align="center">
  <a href="https://www.dledger.com">Website</a> &middot;
  <a href="https://app.dledger.com">Web App</a> &middot;
  <a href="https://demo.dledger.com">Live Demo</a>
</p>

---

> [!NOTE]
> **Early release** — dledger is under active development (v0.2.x). Features may change and rough edges are expected. Bug reports, feature suggestions, and contributions of any kind are very welcome! Feel free to [open an issue](https://github.com/dledger-com/dledger/issues) or start a discussion.

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
| Testing | Vitest, Playwright (E2E), Cargo test |

## Getting Started

dledger can be built two ways: as a native desktop app via Tauri, or as a static web app running entirely in the browser.

### Prerequisites

- **Rust** (stable, via [rustup](https://rustup.rs/)) — for the Tauri backend and Rust tests
- **Bun** ≥ 1.0 ([bun.sh](https://bun.sh/)) — JS package manager and runtime
- **Tauri system dependencies** — webkit2gtk / libsoup on Linux, Xcode Command Line Tools on macOS, WebView2 + MSVC Build Tools on Windows. See the [Tauri v2 prerequisites](https://v2.tauri.app/start/prerequisites/) for the exact list.

> The web-only build needs just Rust + Bun; you can skip the Tauri system libs if you don't plan to build the desktop app.

### Setup

```sh
bun install
```

### Desktop (Tauri)

```sh
bun run tauri dev       # Launch desktop app in dev mode
bun run tauri build     # Production build (frontend + Rust binary)
```

### Web App

A pure-browser build using sql.js (SQLite WASM) with OPFS persistence — no server required.

```sh
bun run dev             # Vite dev server at http://localhost:1420
bun run build           # Static production build → build/
bun run preview         # Preview the production build locally
```

The `build/` output is fully static and can be deployed to any file host.

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

### Nix (optional)

The repo ships a Nix flake that provides Rust, Bun, and the Tauri system libraries in a single shell — handy if you'd rather not install them globally. With [direnv](https://direnv.net/) installed, the shell activates automatically on `cd` (run `direnv allow` once); otherwise:

```sh
nix develop
```

Nix is just one supported setup — anything that satisfies the prerequisites above works.

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
