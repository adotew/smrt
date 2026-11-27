# Smrt

An Electron app for reading PDFs with notes and highlights, writing markdown, studying flashcards
and quizzes, and opening HTML pages, with a Claude assistant built in. See README.md for what it
does from the user's side.

## Layout

- `electron/` is the main process.
  - `main.ts`: windows, menus and the IPC handlers.
  - `library.ts`: every read and write in the library, including the sidecar files.
  - `assistant.ts`: the Claude Agent SDK.
  - `preload.ts`: exposes the handlers as `window.smrt`.
- `src/` is the React renderer.
  - `App.tsx`: the dockview layout, sidebars, dialogs and menu commands.
  - `views/`: one view per file type.
  - `components/`: shared UI; `components/ui/` holds shadcn components.
  - `lib/`: logic without UI, tested beside it.
  - `styles/`: `app.css` for the app, `tailwind.css` for Tailwind and shadcn.
- `docs/html-pages.md` is bundled into the assistant's instructions, so changing it changes what the
  assistant does.
- `scripts/` holds the dev, seed, build and DMG scripts. `scripts/fixtures/` holds the sample library.

## Commands

Node 24 runs the TypeScript scripts and tests directly.

- `npm run dev`: Vite with hot reload and Electron, against a sample library in `.dev-data/`.
  Changes under `electron/` need a restart. `npm run seed` resets the sample library.
- `npm run check`: type-checks everything.
- `npm test`: runs the `*.test.ts` files with `node:test`.
- `npm run build`: bundles `electron/` into `build/` and the renderer into `dist/`.

Run `npm run check` and `npm test` before you call something done. For UI changes, also try them in
`npm run dev`.

## How things fit together

- The renderer touches files only through `window.smrt`. To add a call:
  1. Add the function to `createHandlers` in `electron/main.ts`.
  2. List it in `channels` in `electron/preload.ts`. A missing entry is a type error.
- Paths from the renderer or the assistant are untrusted. Resolve them through `library.ts`, which
  keeps them inside the library.
- To add a menu command:
  1. Add it to the `Command` union in `electron/main.ts`.
  2. Give it a menu item that calls `send(...)`.
  3. Handle it in `onCommand` in `src/App.tsx`. Commands for the open file go through `PaneHandle`
     in `src/components/Pane.tsx`.
- Edits are saved as they happen; there is no Save command.
  - Before a file is renamed, moved or trashed, `flushEditors()` lets its pending saves land first.
  - The Reader queues its saves through `enqueue`, so an older save never lands last.
- `Reader.tsx` keeps its state in the mutable `s` object and redraws with `update()`, because drags
  and typing change it many times a second. Follow that pattern inside it.
- Undo history for page edits lasts one session; earlier PDF versions are moved to the Trash.

## Style

- No formatter is configured. Match the code around you: two-space indents, double quotes,
  semicolons, lines up to about 140 characters.
- Use comments to explain why, not what, in full sentences. A `shortcut:` comment marks a known,
  deliberate trade-off and says when it would need revisiting.
- Interface text follows macOS conventions: Title Case in menus and buttons, and "…" on items that
  ask for more input. Use British spelling ("colour").
- Styles:
  - Plain CSS lives in `src/styles/app.css`, in the `app` cascade layer. Tailwind utilities are
    mostly used in shadcn components.
  - Take colours from the variables at the top of `app.css`, so light and dark mode both work.
- Icons come from the Solar Linear set. Add new ones to `src/components/Icon.tsx`.

## Releases

Bump `version` in `package.json`, then push a `v<version>` tag, and CI builds and publishes the
signed DMG. Only tag a release when asked.
