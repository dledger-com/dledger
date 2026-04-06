// Tauri builds use adapter-static (SPA mode with fallback).
// Cloudflare Pages builds use adapter-cloudflare (set ADAPTER=cloudflare).
// See: https://svelte.dev/docs/kit/single-page-apps
// See: https://v2.tauri.app/start/frontend/sveltekit/
import adapterStatic from "@sveltejs/adapter-static";
import adapterCloudflare from "@sveltejs/adapter-cloudflare";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

const useCloudflare = process.env.ADAPTER === "cloudflare";

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
