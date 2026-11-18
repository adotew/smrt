import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

// Fast refresh's preamble is an inline script, which index.html's CSP only allows while developing.
const devScripts: Plugin = {
  name: "dev-scripts",
  apply: "serve",
  transformIndexHtml: (html) => html.replace("default-src 'self';", "default-src 'self'; script-src 'self' 'unsafe-inline';"),
};

export default defineConfig({
  // Electron loads the build from file://, so asset URLs must be relative.
  base: "./",
  plugins: [tailwindcss(), react(), devScripts],
  resolve: { alias: { $lib: fileURLToPath(new URL("./src/lib", import.meta.url)) } },
});
