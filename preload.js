const { contextBridge, ipcRenderer } = require("electron");

const channels = [
  "listLibrary",
  "createFolder",
  "importPDF",
  "renamePDF",
  "trashPDF",
  "readPDF",
  "readNotes",
  "saveNotes",
  "readAnnotations",
  "saveAnnotations",
  "readPosition",
  "savePosition",
  "icon",
  "contextMenu",
];

contextBridge.exposeInMainWorld("smrt", {
  platform: process.platform,
  ...Object.fromEntries(channels.map((channel) => [channel, (...args) => ipcRenderer.invoke(channel, ...args)])),
  on: (channel, listener) => ipcRenderer.on(channel, (_event, value) => listener(value)),
});
