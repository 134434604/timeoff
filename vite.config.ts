import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The node server (server/index.mjs) serves dist/ and answers every client
// route with dist/index.html, so no per-route copies are needed here.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5611,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:5610",
      "/healthz": "http://127.0.0.1:5610",
    },
  },
  build: {
    target: "es2022",
  },
});
