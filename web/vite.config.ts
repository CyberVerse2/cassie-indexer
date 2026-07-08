import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  plugins: [svelte()],
  server: {
    port: 5173,
    // dev: call the Hono API same-origin
    proxy: { "/api": "http://localhost:8787" },
  },
});
