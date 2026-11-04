const { app, BrowserWindow, Menu, dialog, ipcMain, nativeImage, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { createLibrary } = require("./library");

const isMac = process.platform === "darwin";

// The library keeps the Swift app's folder name so both apps share it.
const library = createLibrary(path.join(app.getPath("appData"), "macpdf"), { trash: (file) => shell.trashItem(file) });

async function importPDF(window, folder) {
  const { canceled, filePaths } = await dialog.showOpenDialog(window, {
    properties: ["openFile"],
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  return canceled || !filePaths[0] ? null : library.importPDF(filePaths[0], folder);
}

async function icon(kind, size) {
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

function contextMenu(window, items) {
  return new Promise((resolve) => {
    let chosen = null;
    Menu.buildFromTemplate(items.map(({ id, label }) => ({ label, click: () => (chosen = id) }))).popup({
      window,
      callback: () => setImmediate(() => resolve(chosen)),
    });
  });
}

function buildMenu(window) {
  const send = (command) => () => window.webContents.send("command", command);
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(isMac ? [{ role: "appMenu" }] : []),
      { role: "fileMenu" },
      { role: "editMenu" },
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

app.whenReady().then(() => {
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 500,
    title: "Smrt",
    // Elsewhere a hidden title bar would also hide the window controls.
    ...(isMac && { titleBarStyle: "hiddenInset" }),
    show: false,
    webPreferences: { preload: path.join(__dirname, "preload.js") },
  });
  buildMenu(window);

  const handle = (channel, fn) => ipcMain.handle(channel, (_event, ...args) => fn(...args));
  for (const name of ["listLibrary", "createFolder", "renamePDF", "trashPDF", "readPDF", "readNotes", "saveNotes", "readPosition", "savePosition"]) {
    handle(name, library[name]);
  }
  handle("importPDF", (folder) => importPDF(window, folder));
  handle("icon", icon);
  handle("contextMenu", (items) => contextMenu(window, items));

  for (const [event, value] of [["enter-full-screen", true], ["leave-full-screen", false]]) {
    window.on(event, () => window.webContents.send("fullscreen", value));
  }
  window.once("ready-to-show", () => window.show());
  if (process.env.VITE_DEV_SERVER_URL) {
    window.loadURL(process.env.VITE_DEV_SERVER_URL);
    window.webContents.openDevTools({ mode: "detach" });
  } else {
    window.loadFile("dist/index.html");
  }
});

app.on("window-all-closed", () => app.quit());
