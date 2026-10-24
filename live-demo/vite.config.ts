import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The built demo is served by Next.js; this port is for standalone Vite development.
export default defineConfig({
  plugins: [react()],
  base: "/live-demo-app/",
  build: {
    outDir: "../frontend/public/live-demo-app",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: { "/live-api": { target: "http://127.0.0.1:8001", rewrite: (path) => path.replace(/^\/live-api/, "") } },
  },
  preview: {
    port: 5173,
    strictPort: true,
    proxy: { "/live-api": { target: "http://127.0.0.1:8001", rewrite: (path) => path.replace(/^\/live-api/, "") } },
  },
});
