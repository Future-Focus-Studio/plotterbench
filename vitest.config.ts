import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Dedicated test config. Without this, Vitest would pick up vite.config.ts
// (whose `root` is ./web) and look for tests inside the web app. Tests live
// under server/test and exercise the pure server-side logic in Node.
export default defineConfig({
  resolve: {
    alias: {
      "@shared": fileURLToPath(new URL("./shared", import.meta.url)),
    },
  },
  test: {
    root: fileURLToPath(new URL(".", import.meta.url)),
    include: ["server/test/**/*.test.ts"],
    environment: "node",
  },
});
