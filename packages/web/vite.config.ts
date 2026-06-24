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
  preview: {
    port: 4173,
    host: "127.0.0.1",
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
    // Drop a stray mockServiceWorker.js from the bundle (v0.5 / Bug 4
    // — production nginx logs showed GET /mockServiceWorker.js).
    rollupOptions: {
      output: {
        chunkFileNames: (chunkInfo) => {
          if (/mockServiceWorker/i.test(chunkInfo.name)) return "[empty].js";
          return "assets/[name]-[hash].js";
        },
      },
    },
  },
});
