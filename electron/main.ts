import {
  app,
  BrowserWindow,
  Menu,
  dialog,
  ipcMain,
  nativeTheme,
  net,
  protocol,
  shell,
  type MenuItemConstructorOptions,
} from "electron";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import htmlGuide from "../docs/html-pages.md";
import { createAssistant } from "./assistant.ts";
import { createLibrary, withPageStyle } from "./library.ts";
import pageStyle from "./page.css";
import { newerRelease } from "./updates.ts";

export type Command =
  | "undo"
  | "redo"
  | "toggleSidebar"
  | "toggleNotes"
  | "toggleSplit"
  | "zoomReset"
  | "zoomIn"
  | "zoomOut"
  | "zoomFit";
export type Theme = "system" | "light" | "dark";

const isMac = process.platform === "darwin";

// Dev runs show "Electron" otherwise.
app.setName("Smrt");
// Dev runs keep their own data, so they never touch the real library and can run beside the installed app.
if (process.env.SMRT_USER_DATA) app.setPath("userData", process.env.SMRT_USER_DATA);
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
const settingsPath = path.join(app.getPath("userData"), "settings.json");
function readTheme(): Theme {
  try {
    const { theme } = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    if (theme === "light" || theme === "dark") return theme;
  } catch {}
  return "system";
}
function setTheme(theme: Theme) {
  if (theme !== "system" && theme !== "light" && theme !== "dark") throw new Error("Unknown theme.");
  nativeTheme.themeSource = theme;
  fs.writeFileSync(settingsPath, JSON.stringify({ theme }));
}
nativeTheme.themeSource = readTheme();

const library = createLibrary(libraryPath, { trash: (file) => shell.trashItem(file), versionsPath });
// Standard so an HTML page's relative links resolve, secure so its scripts get secure-context APIs.
protocol.registerSchemesAsPrivileged([
  { scheme: "smrt-file", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

async function importPDF(window: BrowserWindow, folder: string) {
  const { canceled, filePaths } = await dialog.showOpenDialog(window, {
    properties: ["openFile"],
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  return canceled || !filePaths[0] ? null : library.importPDF(filePaths[0], folder);
}

/** Quiet checks, as on launch, only speak up when there is an update. */
async function checkForUpdates(window: BrowserWindow, quiet: boolean) {
  const current = app.getVersion();
  let update;
  try {
    update = await newerRelease(current);
  } catch (error) {
    if (!quiet) {
      const detail = error instanceof Error ? error.message : String(error);
      await dialog.showMessageBox(window, { type: "warning", message: "Smrt couldn't check for updates.", detail });
    }
    return;
  }
  if (update) {
    const { response } = await dialog.showMessageBox(window, {
      message: `Smrt ${update.version} is available`,
      detail: `You have version ${current}.`,
      buttons: ["Download", "Later"],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) await shell.openExternal(update.url);
  } else if (!quiet) {
    await dialog.showMessageBox(window, { message: "Smrt is up to date", detail: `Version ${current} is the newest.` });
  }
}

let settingsWindow: BrowserWindow | null = null;
function openSettings() {
  if (settingsWindow) return settingsWindow.focus();
  settingsWindow = new BrowserWindow({
    width: 420,
    height: 240,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: "Settings",
    backgroundColor: windowBackground(),
    webPreferences: { preload: path.join(__dirname, "preload.cjs") },
  });
  settingsWindow.setMenuBarVisibility(false);
  settingsWindow.on("closed", () => (settingsWindow = null));
  load(settingsWindow, "settings");
}

/** Loads the renderer; the hash picks the window's view. */
function load(window: BrowserWindow, hash?: string) {
  // A clicked or dropped link would otherwise replace the app with the page.
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  // HTML pages' new-window links open in the browser.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  if (process.env.VITE_DEV_SERVER_URL) window.loadURL(process.env.VITE_DEV_SERVER_URL + (hash ? `#${hash}` : ""));
  else window.loadFile("dist/index.html", { hash });
}

function buildMenu(window: BrowserWindow) {
  const send = (command: Command) => () => window.webContents.send("command", command);
  // Inside an HTML page's frame, undo belongs to the page.
  const undoable = (command: "undo" | "redo") => () =>
    window.webContents.focusedFrame?.parent ? window.webContents[command]() : send(command)();
  const checkItem = { label: "Check for Updates…", click: () => checkForUpdates(window, false) };
  const settingsItem = { label: "Settings…", accelerator: "CmdOrCtrl+,", click: openSettings };
  const appMenu: MenuItemConstructorOptions = {
    label: app.name,
    submenu: [
      { role: "about" },
      checkItem,
      { type: "separator" },
      settingsItem,
      { type: "separator" },
      { role: "services" },
      { type: "separator" },
      { role: "hide" },
      { role: "hideOthers" },
      { role: "unhide" },
      { type: "separator" },
      { role: "quit" },
    ],
  };
  const helpMenu: MenuItemConstructorOptions = { role: "help", submenu: [checkItem] };
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(isMac ? [appMenu] : []),
      { role: "fileMenu" },
      {
        label: "Edit",
        submenu: [
          // The renderer decides between a text field's own undo and the document's.
          { label: "Undo", accelerator: "CmdOrCtrl+Z", click: undoable("undo") },
          { label: "Redo", accelerator: "Shift+CmdOrCtrl+Z", click: undoable("redo") },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "selectAll" },
          ...(isMac ? [] : [{ type: "separator" } as const, settingsItem]),
        ],
      },
      {
        label: "View",
        submenu: [
          // Shown but left to the renderer, so a text editor's own Cmd+B (bold) wins.
          { label: "Toggle Sidebar", accelerator: "CmdOrCtrl+B", registerAccelerator: false, click: send("toggleSidebar") },
          { label: "Toggle Notes", accelerator: "CmdOrCtrl+Shift+N", click: send("toggleNotes") },
          { label: "Toggle Split View", accelerator: "CmdOrCtrl+\\", click: send("toggleSplit") },
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
      ...(isMac ? [] : [helpMenu]),
    ]),
  );
}

/** Everything the renderer may invoke; preload.ts exposes these as `window.smrt`. */
function createHandlers(window: BrowserWindow) {
  const { inLibrary: _inLibrary, urlFile: _urlFile, ...exposed } = library;
  const assistant = createAssistant(libraryPath, htmlGuide, (chunk) => window.webContents.send("assistant", chunk));
  return {
    ...exposed,
    askAssistant: assistant.ask,
    answerAssistant: assistant.answer,
    stopAssistant: assistant.stop,
    readAccount: assistant.account,
    signIn: assistant.signIn,
    enterSignInCode: assistant.enterSignInCode,
    importPDF: (folder: string) => importPDF(window, folder),
    readTheme,
    setTheme,
  };
}

export type Handlers = ReturnType<typeof createHandlers>;

app.whenReady().then(() => {
  protocol.handle("smrt-file", async (request) => {
    if (request.url === "smrt-file://app/page.css") return new Response(pageStyle, { headers: { "content-type": "text/css" } });
    try {
      const file = library.urlFile(request.url);
      if (/\.html$/i.test(file)) {
        // shortcut: assumes UTF-8, as nearly all generated pages are; sniff the charset if others turn up.
        const html = withPageStyle(await fs.promises.readFile(file, "utf8"));
        return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      return await net.fetch(pathToFileURL(file).href);
    } catch {
      return new Response(null, { status: 404 });
    }
  });

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
    backgroundColor: windowBackground(),
    webPreferences: { preload: path.join(__dirname, "preload.cjs") },
  });
  buildMenu(window);
  app.on("second-instance", () => window.show());

  for (const [channel, fn] of Object.entries(createHandlers(window))) {
    ipcMain.handle(channel, (_event, ...args) => (fn as (...args: unknown[]) => unknown)(...args));
  }

  // Shows while resizing before the page repaints, so match --background in app.css.
  nativeTheme.on("updated", () => {
    for (const w of BrowserWindow.getAllWindows()) w.setBackgroundColor(windowBackground());
  });
  window.on("enter-full-screen", () => window.webContents.send("fullscreen", true));
  window.on("leave-full-screen", () => window.webContents.send("fullscreen", false));
  window.once("ready-to-show", () => {
    window.show();
    if (app.isPackaged) checkForUpdates(window, true);
  });
  load(window);
  if (process.env.VITE_DEV_SERVER_URL) window.webContents.openDevTools({ mode: "detach" });
});

function windowBackground() {
  return nativeTheme.shouldUseDarkColors ? "#1e1e1e" : "#fff";
}

app.on("window-all-closed", () => app.quit());
