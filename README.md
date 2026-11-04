# macpdf (Electron)

An Electron + Svelte port of the SwiftUI [macpdf](../macpdf) app. It uses pdf.js to render
PDFs and the same library folder, `~/Library/Application Support/macpdf/`, so both
apps share folders, notes (`<name>.notes.json`) and reading positions (stored in the
`dev.macpdf.reading-position` extended attribute).

## Run

Requires Node 20 or later on macOS.

```sh
npm install
npm start
```

`npm start` builds the Svelte renderer into `dist/` and launches Electron. The window
goes fullscreen when it opens. Use **Control + Command + F** to leave or re-enter
fullscreen, **Control + Command + S** to toggle the sidebar, and **Command + Shift + N**
to toggle notes. Zoom with a pinch, **Command + =/−**, **Command + 0** (actual size),
or **Command + 9** (fit).

Chromium's own data goes in `~/Library/Application Support/MacPDF Electron/`, not
the library folder.

## Package

```sh
npm run package
open release/MacPDF-darwin-arm64/MacPDF.app
```

This writes an unsigned Apple Silicon app bundle. Right-click it and choose **Open**
the first time if macOS blocks it.

## Test

```sh
npm test
```

Tests cover folder and name validation, PDF importing and renaming, notes, reading
positions, and duplicate-file protection in `library.js`.
