import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import tsConfigPaths from "vite-tsconfig-paths";

// Sestavení pro Cloudflare Workers: TanStack Start vyrenderuje aplikaci a Nitro
// z ní udělá worker (nastavení cílové platformy je v nitro.config.ts).
export default defineConfig({
  server: { port: 8080 },
  resolve: { dedupe: ["react", "react-dom", "@tanstack/react-router"] },
  plugins: [
    tsConfigPaths(),
    tailwindcss(),
    // Vlastní serverový vstup se SSR ochranou chyb: src/server.ts
    tanstackStart({ server: { entry: "server" } }),
    nitro(),
    viteReact(),
  ],
});
