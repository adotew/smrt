# Smrt

A PDF library and reader with per-page notes and a markdown editor, built with Electron, Svelte,
TypeScript, pdf.js and Tiptap. It runs on macOS, Windows and Linux.

PDFs and markdown files live in folders inside the `Library` folder in Smrt's app data directory:

| System  | Library folder                                 |
| ------- | ---------------------------------------------- |
| macOS   | `~/Library/Application Support/Smrt/Library/`  |
| Windows | `%APPDATA%\Smrt\Library\`                     |
| Linux   | `~/.config/Smrt/Library/`                      |

Each PDF can have sidecar files next to it: `<name>.notes.json` for page notes,
`<name>.annotations.json` for highlights and text boxes, and `<name>.position.json`
for the last page and zoom.

Right-click a page to insert a blank page after it, duplicate, rotate or delete it.
These edits rewrite the PDF itself; the previous version goes to the Trash each time.
Undo covers page edits, highlights, notes and text boxes until you open another PDF or quit.

Right-click a folder and choose **New Markdown File…** to write notes of your own. They are
plain `.md` files, saved as you type; images are embedded in them as data URLs.

On first launch, an existing library from the old macpdf app is copied over; the
original folder is left as it was.

## Run

Requires Node 24 or later, which runs the TypeScript build scripts and tests directly.

```sh
npm install
npm start
```

For development with hot-reloading:

```sh
npm run dev
```

This serves the renderer from Vite at http://localhost:5173 and opens Electron
against it, so Svelte/CSS edits update the window instantly. Changes under
`electron/` still need a restart.

`npm start` bundles the main and preload processes from `electron/` into `build/`,
builds the Svelte renderer into `dist/`, and launches Electron.

| Action          | macOS                    | Windows and Linux     |
| --------------- | ------------------------ | --------------------- |
| Undo / redo     | Command + Z / Shift + Command + Z | Ctrl + Z / Shift + Ctrl + Z |
| Toggle sidebar  | Control + Command + S    | Ctrl + Shift + S      |
| Toggle notes    | Command + Shift + N      | Ctrl + Shift + N      |
| Zoom in / out   | Command + = / −          | Ctrl + = / −          |
| Actual size     | Command + 0              | Ctrl + 0              |
| Zoom to fit     | Command + 9              | Ctrl + 9              |
| Fullscreen      | Control + Command + F    | F11                   |

You can also pinch to zoom on a trackpad.

## Package

```sh
npm run package
```

This writes an unsigned app for the system you run it on to
`release/Smrt-<platform>-<arch>/`. For example, on an Apple Silicon Mac:

```sh
open release/Smrt-darwin-arm64/Smrt.app
```

If macOS blocks the app, right-click it and choose **Open** the first time.

## Check and test

```sh
npm run check
npm test
```

`check` type-checks the whole app, including the Svelte components. The IPC API in
`window.smrt` is typed from the handlers in `electron/main.ts`.

Tests cover folder and name validation, PDF importing and renaming, markdown files, notes,
reading positions, page edits, and duplicate-file protection in `electron/library.ts`.
