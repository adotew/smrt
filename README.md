# Smrt

A PDF library and reader with per-page notes, built with Electron, Svelte and pdf.js.
It runs on macOS, Windows and Linux, and started as a port of the SwiftUI
[macpdf](../macpdf) app.

PDFs live in folders inside a `macpdf` library folder in the system's app data
directory:

| System  | Library folder                             |
| ------- | ------------------------------------------ |
| macOS   | `~/Library/Application Support/macpdf/`    |
| Windows | `%APPDATA%\macpdf\`                        |
| Linux   | `~/.config/macpdf/`                        |

Notes are saved next to each PDF as `<name>.notes.json`. On macOS, the last page and
zoom are stored in the PDF's `dev.macpdf.reading-position` extended attribute, so the
Swift app shares the same library, notes and positions. On Windows and Linux, they go
in a `<name>.position.json` file next to the PDF.

## Run

Requires Node 20 or later.

```sh
npm install
npm start
```

For development with hot-reloading:

```sh
npm run dev
```

This serves the renderer from Vite at http://localhost:5173 and opens Electron
against it, so Svelte/CSS edits update the window instantly. Changes to
`main.js`, `preload.js` or `library.js` still need a restart.

`npm start` builds the Svelte renderer into `dist/` and launches Electron.

| Action          | macOS                    | Windows and Linux     |
| --------------- | ------------------------ | --------------------- |
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

## Test

```sh
npm test
```

Tests cover folder and name validation, PDF importing and renaming, notes, reading
positions, and duplicate-file protection in `library.js`.
