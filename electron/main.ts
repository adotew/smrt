import { app, BrowserWindow, Menu, dialog, ipcMain, nativeImage, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
import { createLibrary } from "./library.ts";

export type MenuItem = { id: string; label: string } | { type: "separator" };
export type Command =
  | "undo"
  | "redo"
  | "toggleSidebar"
  | "toggleNotes"
  | "zoomReset"
  | "zoomIn"
  | "zoomOut"
  | "zoomFit";

const isMac = process.platform === "darwin";

// Dev runs show "Electron" otherwise.
app.setName("Smrt");
// A second copy would clear the first one's undo versions below.
if (!app.requestSingleInstanceLock()) {
  console.error("Smrt is already running.");
  process.exit(0);
}

const libraryPath = path.join(app.getPath("userData"), "Library");
// One-time copy of the library from the deprecated Swift app; its folder is left untouched.
const swiftLibrary = path.join(app.getPath("appData"), "macpdf");
if (!fs.existsSync(libraryPath) && fs.existsSync(swiftLibrary)) fs.cpSync(swiftLibrary, libraryPath, { recursive: true });
// Undo history lasts one session, so earlier versions are cleared on launch.
const versionsPath = path.join(app.getPath("temp"), "Smrt Versions");
fs.rmSync(versionsPath, { recursive: true, force: true });
const library = createLibrary(libraryPath, { trash: (file) => shell.trashItem(file), versionsPath });

async function importPDF(window: BrowserWindow, folder: string) {
  const { canceled, filePaths } = await dialog.showOpenDialog(window, {
    properties: ["openFile"],
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  return canceled || !filePaths[0] ? null : library.importPDF(filePaths[0], folder);
}

async function icon(kind: "folder" | "pdf", size: number) {
  let target = library.root;
  if (kind === "pdf") {
    target = path.join(app.getPath("temp"), "smrt-icon.pdf");
    fs.writeFileSync(target, "");
  }
  // getFileIcon's "large" size crashes on macOS, so big icons come from the system thumbnailer,
  // which Linux lacks.
  if (size > 32) {
    try {
      return (await nativeImage.createThumbnailFromPath(target, { width: size, height: size })).toDataURL();
    } catch {}
  }
  return (await app.getFileIcon(target, { size: isMac ? "normal" : "large" })).toDataURL();
}

function contextMenu(window: BrowserWindow, items: MenuItem[]) {
  return new Promise<string | null>((resolve) => {
    let chosen: string | null = null;
    Menu.buildFromTemplate(
      items.map((item) => ("type" in item ? item : { label: item.label, click: () => (chosen = item.id) })),
    ).popup({
      window,
      callback: () => setImmediate(() => resolve(chosen)),
    });
  });
}

function buildMenu(window: BrowserWindow) {
  const send = (command: Command) => () => window.webContents.send("command", command);
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(isMac ? [{ role: "appMenu" } as const] : []),
      { role: "fileMenu" },
      {
        label: "Edit",
        submenu: [
          // The renderer decides between a text field's own undo and the document's.
          { label: "Undo", accelerator: "CmdOrCtrl+Z", click: send("undo") },
          { label: "Redo", accelerator: "Shift+CmdOrCtrl+Z", click: send("redo") },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "selectAll" },
        ],
      },
      {
        label: "View",
        submenu: [
          { label: "Toggle Sidebar", accelerator: isMac ? "Ctrl+Cmd+S" : "Ctrl+Shift+S", click: send("toggleSidebar") },
          { label: "Toggle Notes", accelerator: "CmdOrCtrl+Shift+N", click: send("toggleNotes") },
          { type: "separator" },
          { label: "Actual Size", accelerator: "CmdOrCtrl+0", click: send("zoomReset") },
          { label: "Zoom In", accelerator: "CmdOrCtrl+=", click: send("zoomIn") },
          { label: "Zoom Out", accelerator: "CmdOrCtrl+-", click: send("zoomOut") },
          { label: "Zoom to Fit", accelerator: "CmdOrCtrl+9", click: send("zoomFit") },
          { type: "separator" },
          { role: "togglefullscreen" },
          { role: "toggleDevTools" },
        ],
      },
      { role: "windowMenu" },
    ]),
  );
}

/** Everything the renderer may invoke; preload.ts exposes these as `window.smrt`. */
function createHandlers(window: BrowserWindow) {
  const { root, inLibrary, ...exposed } = library;
  return {
    ...exposed,
    importPDF: (folder: string) => importPDF(window, folder),
    icon,
    contextMenu: (items: MenuItem[]) => contextMenu(window, items),
  };
}

export type Handlers = ReturnType<typeof createHandlers>;

app.whenReady().then(() => {
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 500,
    title: "Smrt",
    // Elsewhere a hidden title bar would also hide the window controls.
    // y centres the traffic lights in the 52px toolbar.
    ...(isMac && { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 18, y: 19 } }),
    show: false,
    webPreferences: { preload: path.join(__dirname, "preload.cjs") },
  });
  buildMenu(window);
  app.on("second-instance", () => window.show());

  for (const [channel, fn] of Object.entries(createHandlers(window))) {
    ipcMain.handle(channel, (_event, ...args) => (fn as (...args: unknown[]) => unknown)(...args));
  }

  window.on("enter-full-screen", () => window.webContents.send("fullscreen", true));
  window.on("leave-full-screen", () => window.webContents.send("fullscreen", false));
  window.once("ready-to-show", () => window.show());
  if (process.env.VITE_DEV_SERVER_URL) {
    window.loadURL(process.env.VITE_DEV_SERVER_URL);
    window.webContents.openDevTools({ mode: "detach" });
  } else {
    window.loadFile("dist/index.html");
  }
});

app.on("window-all-closed", () => app.quit());
