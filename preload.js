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
  "readPosition",
  "savePosition",
  "icon",
  "thumbnail",
  "contextMenu",
];

contextBridge.exposeInMainWorld("macpdf", {
  ...Object.fromEntries(channels.map((channel) => [channel, (...args) => ipcRenderer.invoke(channel, ...args)])),
  on: (channel, listener) => ipcRenderer.on(channel, (_event, value) => listener(value)),
});
