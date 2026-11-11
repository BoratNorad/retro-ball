import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

export default defineConfig({
  base: "./",
  plugins: [preact()],
  build: { target: "es2022", chunkSizeWarningLimit: 2000 },
  server: { host: true, port: 5173 },
});
