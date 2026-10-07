import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The Hyphae console dev server.
 *
 * API and WebSocket traffic is proxied to a local Hub (`wrangler dev` on
 * 8787 by default) so there are no CORS or origin differences in dev. In a
 * production deploy the built assets are served by the edge Worker itself,
 * so every fetch is same-origin and no proxy is involved.
 */
const hubTarget = process.env.HYPHAE_HUB_TARGET ?? "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname,
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/health": hubTarget,
      "/repos": hubTarget,
      "/blobs": hubTarget,
      "/agents": { target: hubTarget, ws: true },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
