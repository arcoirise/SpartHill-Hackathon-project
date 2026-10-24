import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Port 3000 matches the start scripts, README and the backend's CORS allowlist.
export default defineConfig({
  plugins: [react()],
  server: { port: 3000, strictPort: true },
  preview: { port: 3000, strictPort: true },
});
