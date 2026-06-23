import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    host: true,
    proxy: {
      "/api": {
        target: process.env.VITE_API_URL || "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
    // Defensive: never let a stray `mockServiceWorker.js` land in the
    // production bundle. MSW is intentionally NOT a dependency of this
    // package (the dashboard talks to the real API) — but a future
    // dev who adds it for unit testing should not have their worker
    // file deployed. (v0.5 / Bug 4 — production nginx logs showed
    // GET /mockServiceWorker.js requests.)
    rollupOptions: {
      output: {
        // Vite hashes asset filenames, so we can only exclude by
        // pattern at the chunk level. Anything matching the worker
        // filename is dropped from the emitted chunks.
        chunkFileNames: (chunkInfo) => {
          if (/mockServiceWorker/i.test(chunkInfo.name)) return "[empty].js";
          return "assets/[name]-[hash].js";
        },
      },
    },
  },
});
