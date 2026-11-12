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
    // The page stylesheet main.ts serves and the HTML guide the assistant reads are bundled in, as the packaged app leaves out electron/ and docs/.
    loader: { ".css": "text", ".md": "text" },
    sourcemap: true,
    logLevel: "warning",
  });

if (import.meta.main) await buildElectron();
