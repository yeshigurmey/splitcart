import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  server: {
    // While developing, the web app runs on Vite's port and the API on 3000.
    // Forwarding /api keeps both on one origin, so the session cookie works.
    proxy: { "/api": "http://localhost:3000" },
  },
  build: { outDir: "dist" },
  test: { include: ["src/**/*.test.ts"] },
});
