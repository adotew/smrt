const { app, BrowserWindow, Menu, dialog, ipcMain, nativeImage, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { createLibrary } = require("./library");

// Chromium's default profile, Application Support/MacPDF, is the library folder on case-insensitive volumes.
app.setPath("userData", path.join(app.getPath("appData"), "MacPDF Electron"));

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
    target = path.join(app.getPath("temp"), "macpdf-icon.pdf");
    fs.writeFileSync(target, "");
  }
  // getFileIcon's "large" size crashes on macOS, so big icons come from QuickLook instead.
  const image =
    size > 32
      ? await nativeImage.createThumbnailFromPath(target, { width: size, height: size })
      : await app.getFileIcon(target, { size: "normal" });
  return image.toDataURL();
}

async function thumbnail(pdf) {
  try {
    const image = await nativeImage.createThumbnailFromPath(library.inLibrary(pdf), { width: 312, height: 312 });
    return image.toDataURL();
  } catch {
    return null;
  }
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
      { role: "appMenu" },
      { role: "fileMenu" },
      { role: "editMenu" },
      {
        label: "View",
        submenu: [
          { label: "Toggle Sidebar", accelerator: "Ctrl+Cmd+S", click: send("toggleSidebar") },
          { label: "Toggle Notes", accelerator: "Cmd+Shift+N", click: send("toggleNotes") },
          { type: "separator" },
          { label: "Actual Size", accelerator: "Cmd+0", click: send("zoomReset") },
          { label: "Zoom In", accelerator: "Cmd+=", click: send("zoomIn") },
          { label: "Zoom Out", accelerator: "Cmd+-", click: send("zoomOut") },
          { label: "Zoom to Fit", accelerator: "Cmd+9", click: send("zoomFit") },
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
    title: "MacPDF",
    titleBarStyle: "hiddenInset",
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
  handle("thumbnail", thumbnail);
  handle("contextMenu", (items) => contextMenu(window, items));

  for (const [event, value] of [["enter-full-screen", true], ["leave-full-screen", false]]) {
    window.on(event, () => window.webContents.send("fullscreen", value));
  }
  window.once("ready-to-show", () => {
    window.show();
    window.setFullScreen(true);
  });
  window.loadFile("dist/index.html");
});

app.on("window-all-closed", () => app.quit());
