import { app, autoUpdater, BrowserWindow, dialog, type MessageBoxOptions } from "electron";

// update.electronjs.org serves the newest GitHub release's `-darwin-arm64.zip` to Squirrel.Mac.
const FEED = `https://update.electronjs.org/adotew/smrt/${process.platform}-${process.arch}/${app.getVersion()}`;

// Checks on launch stay silent unless there is an update; one from the menu also reports "up to date" and errors.
let quiet = true;
let downloading = false;
let downloaded: string | null = null;

function show(options: MessageBoxOptions) {
  const window = BrowserWindow.getFocusedWindow();
  return window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options);
}

async function offerRestart(version: string) {
  const { response } = await show({
    message: `Smrt ${version} is ready to install`,
    detail: `You have version ${app.getVersion()}. If you wait, it installs the next time Smrt starts.`,
    buttons: ["Restart to Update", "Later"],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) autoUpdater.quitAndInstall();
}

/** Call once in the packaged app; it checks right away and downloads any update in the background. */
export function startUpdates() {
  autoUpdater.setFeedURL({ url: FEED });
  autoUpdater.on("update-available", () => {
    downloading = true;
  });
  autoUpdater.on("update-not-available", () => {
    if (!quiet) show({ message: "Smrt is up to date", detail: `Version ${app.getVersion()} is the newest.` });
    quiet = true;
  });
  autoUpdater.on("update-downloaded", (_event, _notes, name) => {
    downloading = false;
    downloaded = name.replace(/^Smrt\s*/, "").replace(/^v/, "");
    quiet = true;
    offerRestart(downloaded);
  });
  autoUpdater.on("error", (error) => {
    downloading = false;
    if (!quiet) show({ type: "warning", message: "Smrt couldn't check for updates.", detail: error.message });
    quiet = true;
  });
  autoUpdater.checkForUpdates();
}

export function checkForUpdates() {
  if (downloaded) return offerRestart(downloaded);
  if (downloading) return show({ message: "An update is downloading", detail: "Smrt will ask to restart once it's ready." });
  quiet = false;
  autoUpdater.checkForUpdates();
}
