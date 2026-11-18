# Smrt

A PDF library and reader with per-page notes and a markdown editor, built with Electron, React,
TypeScript, pdf.js and Tiptap. It runs on macOS, Windows and Linux.

PDFs, markdown files and flashcard decks live in folders inside the `Library` folder in Smrt's app data directory:

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
While you edit a text box, the bar above the PDF toolbar makes its text bold, italic or underlined
changes its size and colour.

Right-click a folder and choose **New Markdown File…** to write notes of your own. They are
plain `.md` files, saved as you type; images are embedded in them as data URLs. Type `/` to
add headings, lists, checklists, quotes, code, dividers or images, and select text to format it.

Choose **New Flashcard Deck…** on a folder to make a `.cards` file. A deck opens ready to study:
press Space to flip a card and ← → to move between cards. Right-click a deck and choose
**Edit Cards** to add or change cards; both sides are written in markdown.

Ask the assistant to quiz you and the questions appear in the chat, one at a time: multiple choice,
true or false, and fill in the blank. Ask it to keep the quiz and it is saved as a `.quiz` file that
opens the same way.

`.html` files placed in a folder open as interactive pages. Their scripts run in a sandbox
without access to the library, relative links to files beside them work, and links that open
a new window go to your browser. Pages take on Smrt's fonts and colours, in light and dark mode,
unless they style themselves; [docs/html-pages.md](docs/html-pages.md) explains how to write pages,
for people and AI agents alike.

Press ⌘J to ask the assistant about the open file or your library. It is Claude, running on your
own Claude subscription through the Claude Agent SDK: sign in under **Settings → Claude**. It can read
anything in the library and create notes, flashcard decks, quizzes and HTML pages; it asks before changing a file
that already exists, and can't touch anything outside the library.

On first launch, an existing library from the old macpdf app is copied over; the
original folder is left as it was.

## Install

On an Apple Silicon Mac, download `Smrt-<version>-arm64.dmg` from the
[latest release](https://github.com/adotew/smrt/releases/latest), open it and drag Smrt into
Applications.

Smrt checks for a newer release on launch and offers to open its download page;
**Smrt → Check for Updates…** checks by hand.

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
against it, so React/CSS edits update the window instantly. Changes under
`electron/` still need a restart.

Dev runs use their own data in `.dev-data/` instead of your real library. It is filled
with sample PDFs, notes, highlights, markdown files and decks on first run; `npm run seed`
resets it.

`npm start` bundles the main and preload processes from `electron/` into `build/`,
builds the React renderer into `dist/`, and launches Electron.

| Action          | macOS                    | Windows and Linux     |
| --------------- | ------------------------ | --------------------- |
| Undo / redo     | Command + Z / Shift + Command + Z | Ctrl + Z / Shift + Ctrl + Z |
| Toggle sidebar  | Control + Command + S    | Ctrl + Shift + S      |
| Toggle notes    | Command + Shift + N      | Ctrl + Shift + N      |
| Split view      | Command + \              | Ctrl + \              |
| Zoom in / out   | Command + = / −          | Ctrl + = / −          |
| Actual size     | Command + 0              | Ctrl + 0              |
| Zoom to fit     | Command + 9              | Ctrl + 9              |
| Fullscreen      | Control + Command + F    | F11                   |

You can also pinch to zoom on a trackpad.

Right-click a file and choose **Open in Split View** to show it beside the current one. Drag the
divider to resize the panes, or all the way to an edge to close one; the sidebar and menu commands
act on the pane you last clicked.

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

```sh
npm run dmg
```

This packages and signs the Apple Silicon app, then writes, signs and notarizes
`release/Smrt-<version>-arm64.dmg`. It needs a Developer ID Application certificate in the keychain
and notarization credentials stored once:

```sh
xcrun notarytool store-credentials smrt --apple-id <apple-id> --team-id 4QXWK32FYX
```

## Release

1. Bump `version` in `package.json`, commit and push.
2. Build the disk image: `npm run dmg`.
3. Publish it as a release tagged with the version:

   ```sh
   gh release create v1.0.2 release/Smrt-1.0.2-arm64.dmg --title "Smrt 1.0.2" --notes "…"
   ```

Installed copies compare their version with the latest release's tag and offer the update.

## Check and test

```sh
npm run check
npm test
```

`check` type-checks the whole app, including the React components. The IPC API in
`window.smrt` is typed from the handlers in `electron/main.ts`.

Tests cover folder and name validation, PDF importing and renaming, markdown files, notes,
reading positions, page edits, and duplicate-file protection in `electron/library.ts`.
