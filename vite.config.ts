import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

export default defineConfig({
  // Electron loads the build from file://, so asset URLs must be relative.
  base: "./",
  plugins: [svelte()],
});
