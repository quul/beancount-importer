import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { hostname } from "node:os";

export default defineConfig({
  root: "web",
  plugins: [react()],
  build: { outDir: path.resolve(__dirname, "web-dist"), emptyOutDir: true },
  server: {
    allowedHosts: [hostname().toLowerCase()],
    proxy: {
      "/api": { target: "http://127.0.0.1:8787", xfwd: true },
    },
  },
});
