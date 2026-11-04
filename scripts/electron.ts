// Bundles the main and preload processes into build/, as CommonJS because Electron's sandboxed preloads require it.
import { build } from "esbuild";

export const buildElectron = () =>
  build({
    entryPoints: ["electron/main.ts", "electron/preload.ts"],
    outdir: "build",
    outExtension: { ".js": ".cjs" },
    bundle: true,
    platform: "node",
    format: "cjs",
    packages: "external",
    sourcemap: true,
    logLevel: "warning",
  });

if (import.meta.main) await buildElectron();
