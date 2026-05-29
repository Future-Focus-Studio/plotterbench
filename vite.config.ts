import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL("./web", import.meta.url)),
  plugins: [react()],
  server: {
    port: 49173,
    strictPort: true,
    proxy: {
      "/api": "http://localhost:49787",
      // /ws is intentionally NOT proxied. The browser opens the WebSocket
      // directly to ws://localhost:49787/ws (see openWs in web/src/api.ts).
    },
  },
  build: {
    outDir: fileURLToPath(new URL("./dist/web", import.meta.url)),
    emptyOutDir: true,
  },
});
