// @ts-nocheck
import { execSync } from "child_process";
import { readFileSync } from "fs";
import { defineConfig } from "vite";
import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { paraglideVitePlugin } from "@inlang/paraglide-js";

const host = process.env.TAURI_DEV_HOST;

const pkg = JSON.parse(readFileSync("./package.json", "utf-8"));
const gitHash = execSync("git rev-parse --short HEAD").toString().trim();

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [
    tailwindcss(),
    paraglideVitePlugin({
      project: "./project.inlang",
      outdir: "./src/paraglide",
    }),
    sveltekit(),
  ],

  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __GIT_HASH__: JSON.stringify(gitHash),
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
    proxy: {
      '/api/kraken': {
        target: 'https://api.kraken.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/kraken/, ''),
      },
      '/api/binance': {
        target: 'https://api.binance.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/binance/, ''),
      },
      '/api/coinbase': {
        target: 'https://api.coinbase.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/coinbase/, ''),
      },
      '/api/bybit': {
        target: 'https://api.bybit.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/bybit/, ''),
      },
      '/api/okx': {
        target: 'https://www.okx.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/okx/, ''),
      },
      '/api/bitstamp': {
        target: 'https://www.bitstamp.net',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/bitstamp/, ''),
      },
      '/api/cryptocom': {
        target: 'https://api.crypto.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/cryptocom/, ''),
      },
      '/api/volet': {
        target: 'https://account.volet.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/volet/, ''),
      },
      '/api/hyperliquid': {
        target: 'https://api.hyperliquid.xyz',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/hyperliquid/, ''),
      },
      '/api/sui': {
        target: 'https://graphql.mainnet.sui.io',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/sui/, ''),
      },
      '/api/aptos': {
        target: 'https://api.mainnet.aptoslabs.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/aptos/, ''),
      },
      '/api/ton': {
        target: 'https://tonapi.io',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/ton/, ''),
      },
      '/api/tezos': {
        target: 'https://api.tzkt.io',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/tezos/, ''),
      },
      '/api/cosmos': {
        target: 'https://lcd-cosmoshub.keplr.app',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/cosmos/, ''),
      },
      '/api/polkadot': {
        target: 'https://polkadot.api.subscan.io',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/polkadot/, ''),
      },
    },
  },
}));
