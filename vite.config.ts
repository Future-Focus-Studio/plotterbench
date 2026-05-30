import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL("./web", import.meta.url)),
  plugins: [react()],
  resolve: {
    alias: {
      // Shared types/defaults live at repo-root /shared; the client imports
      // them as "@shared/...". The server uses relative paths instead.
      "@shared": fileURLToPath(new URL("./shared", import.meta.url)),
    },
  },
  server: {
    port: 49173,
    strictPort: true,
    proxy: {
      // 127.0.0.1, not "localhost": the server binds IPv4 loopback, and Node's
      // verbatim DNS may resolve localhost to ::1 first, which would refuse.
      "/api": "http://127.0.0.1:49787",
      // /ws is intentionally NOT proxied. The browser opens the WebSocket
      // directly to ws://localhost:49787/ws (see openWs in web/src/api.ts).
    },
  },
  build: {
    outDir: fileURLToPath(new URL("./dist/web", import.meta.url)),
    emptyOutDir: true,
  },
});
