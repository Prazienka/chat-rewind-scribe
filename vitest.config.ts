import { defineConfig } from "vitest/config";
import tsConfigPaths from "vite-tsconfig-paths";

// Testy jsou čistá logika – bez TanStack Start a Nitro pluginů z vite.config.ts.
export default defineConfig({
  plugins: [tsConfigPaths()],
  test: { include: ["src/**/*.test.{js,ts}"] },
});
