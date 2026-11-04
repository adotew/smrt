import { contextBridge, ipcRenderer } from "electron";
import type { Command, Handlers } from "./main.ts";

/** `window.smrt`: each handler in main.ts, invoked over IPC. */
export type SmrtApi = {
  [K in keyof Handlers]: (...args: Parameters<Handlers[K]>) => Promise<Awaited<ReturnType<Handlers[K]>>>;
} & {
  platform: NodeJS.Platform;
  on(channel: "fullscreen", listener: (value: boolean) => void): void;
  on(channel: "command", listener: (value: Command) => void): void;
};

// A record, so leaving out or misspelling a handler is a type error.
const channels: Record<keyof Handlers, true> = {
  listLibrary: true,
  createFolder: true,
  importPDF: true,
  renameFile: true,
  trashFile: true,
  createMarkdown: true,
  readMarkdown: true,
  saveMarkdown: true,
  readPDF: true,
  readNotes: true,
  saveNotes: true,
  readAnnotations: true,
  saveAnnotations: true,
  readPosition: true,
  savePosition: true,
  editPage: true,
  restoreVersion: true,
  icon: true,
  contextMenu: true,
};

contextBridge.exposeInMainWorld("smrt", {
  platform: process.platform,
  ...Object.fromEntries(
    Object.keys(channels).map((channel) => [channel, (...args: unknown[]) => ipcRenderer.invoke(channel, ...args)]),
  ),
  on: (channel: string, listener: (value: unknown) => void) => ipcRenderer.on(channel, (_event, value) => listener(value)),
});
