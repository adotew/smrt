// Starts the Vite dev server for the renderer, then launches Electron pointed at it.
// Renderer changes hot-reload; changes to main.js/preload.js need a restart.
const { spawn } = require("node:child_process");

async function main() {
  const { createServer } = await import("vite");
  const server = await createServer({ server: { port: 5173, strictPort: true } });
  await server.listen();
  server.printUrls();

  const electron = spawn(require("electron"), ["."], {
    stdio: "inherit",
    env: { ...process.env, VITE_DEV_SERVER_URL: "http://localhost:5173" },
  });

  const shutdown = () => {
    electron.kill();
    server.close().then(() => process.exit(0));
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  electron.on("exit", shutdown);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
