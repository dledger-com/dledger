# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

dledger is a desktop application built with **Tauri v2 + SvelteKit + TypeScript** (Rust backend, Svelte 5 frontend). It uses Nix flakes for dev environment management with `bun` as the JS package manager.

## Development Commands

### Prerequisites

Enter the Nix dev shell (happens automatically via direnv if `.envrc` is allowed):
```sh
nix develop    # or: direnv allow
```

Install frontend dependencies:
```sh
bun install
```

### Running

```sh
bun run tauri dev     # Launch app in dev mode (starts Vite + Tauri together)
```

### Building

```sh
bun run tauri build   # Production build (frontend + Rust binary)
```

### Type Checking

```sh
bun run check         # Svelte/TS type checking (one-shot)
bun run check:watch   # Svelte/TS type checking (watch mode)
```

### Rust

```sh
cargo check --manifest-path src-tauri/Cargo.toml   # Check Rust code
cargo clippy --manifest-path src-tauri/Cargo.toml   # Lint Rust code
cargo test --manifest-path src-tauri/Cargo.toml     # Run Rust tests
```

## Architecture

- **`src/`** — SvelteKit frontend (SPA mode via `adapter-static`, SSR disabled)
  - `src/routes/` — SvelteKit file-based routing
  - Frontend communicates with Rust via `invoke()` from `@tauri-apps/api/core`
- **`src-tauri/`** — Rust backend (Tauri v2)
  - `src/lib.rs` — App entry point, Tauri command handlers (exposed via `#[tauri::command]`)
  - `src/main.rs` — Binary entry point (calls `dledger_lib::run()`)
  - `Cargo.toml` — Rust dependencies; lib crate named `dledger_lib`
  - `tauri.conf.json` — Tauri config (app identifier: `com.dledger.dledger`)
  - `capabilities/` — Tauri v2 permission capabilities

### Key Details

- Svelte 5 with runes (`$state`, etc.) — not Svelte 4 stores
- Vite dev server runs on port 1420 (strict)
- Tauri `beforeDevCommand` and `beforeBuildCommand` use `bun run dev` / `bun run build`
- TypeScript strict mode enabled

### i18n (Paraglide JS v2)

- **Library**: `@inlang/paraglide-js` — compiler-based, tree-shakeable message functions
- **Config**: `project.inlang/settings.json` — inlang project config
- **Messages**: `messages/en.json` (source), `messages/fr.json` (French)
- **Generated output**: `src/paraglide/` (gitignored, auto-compiled by Vite plugin)
- **Alias**: `$paraglide` → `src/paraglide/` (configured in `svelte.config.js` `kit.alias`)
- **Locale init**: `src/lib/i18n.ts` — `initLocale()` called in root `+layout.svelte` before rendering
- **Usage**: `import * as m from "$paraglide/messages.js"` then `m.key_name()` in templates
- **Locale switching**: Settings page → Language dropdown → `setLocale()` → page reload
- **Key naming**: flat namespace with prefixes: `nav_*`, `btn_*`, `label_*`, `toast_*`, `dialog_*`, `date_*`, `error_*`, `report_*`, `settings_*`, `empty_*`, `state_*`
- **Adding translations**: Add key to both `messages/en.json` and `messages/fr.json`, then use `m.key_name()` in component
- **Parameters**: `"hello {name}"` → `m.hello({ name: "world" })`
