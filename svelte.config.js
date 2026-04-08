// Tauri builds use adapter-static (SPA mode with fallback).
// Cloudflare Workers/Pages builds use adapter-cloudflare.
// Auto-detected via CF build env vars; can be forced with ADAPTER=cloudflare.
// See: https://svelte.dev/docs/kit/single-page-apps
// See: https://v2.tauri.app/start/frontend/sveltekit/
import adapterStatic from "@sveltejs/adapter-static";
import adapterCloudflare from "@sveltejs/adapter-cloudflare";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

const useCloudflare =
  process.env.ADAPTER === "cloudflare" ||
  !!process.env.CF_PAGES ||
  !!process.env.WORKERS_CI ||
  !!process.env.CLOUDFLARE_DEPLOYMENT_ID;

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: useCloudflare
      ? adapterCloudflare({
          routes: {
            include: ["/*"],
            exclude: ["<all>"],
          },
        })
      : adapterStatic({
          fallback: "index.html",
        }),
    alias: {
      "$paraglide": "./src/paraglide",
      "$paraglide/*": "./src/paraglide/*",
    },
  },
};

export default config;
