import { defineConfig } from "nitro";

// Cílová platforma pro produkční build: Cloudflare Workers (moduly).
export default defineConfig({
  preset: "cloudflare_module",
  compatibilityDate: "2026-10-01",
});
