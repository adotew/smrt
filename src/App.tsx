import { Fragment, useEffect, useRef, useState, type PointerEvent } from "react";
import { flushSync } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import type { Command } from "../electron/main.ts";
import type { Folder } from "../electron/library.ts";
import ContextMenu, { contextMenu } from "./ContextMenu.tsx";
import EmptyState from "./EmptyState.tsx";
import FileIcon from "./FileIcon.tsx";
import Icon, { IconButton } from "./Icon.tsx";
import { assistant, useAssistant } from "./assistant.ts";
import Pane, { fileType, type PaneHandle } from "./Pane.tsx";
import { ease } from "./transitions.ts";

const api = window.smrt;

type File = Folder["pdfs"][number];
/** One pane, or two side by side; each shows a PDF, markdown file, deck, quiz or HTML page. */
interface Layout {
  panes: { id: string; path: string | null }[];
  /** Index of the pane the sidebar and menu commands act on. */
  active: number;
  /** The left pane's share of the width in split view. */
  ratio: number;
}

/** The floating sidebar's width plus its margin and the gap beside it; matches `#sidebar` in app.css. */
const SIDEBAR_INSET = 256;

const baseName = (name: string) => name.replace(/\.(pdf|md|cards|quiz|html)$/i, "");
const byName = (a: File, b: File) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
const filesOf = (folder: Folder) => [...folder.pdfs, ...folder.markdown, ...folder.decks, ...folder.quizzes, ...folder.html];
const inFolder = (file: string, folder: string) => file.startsWith(folder) && /[\\/]/.test(file[folder.length] ?? "");

/** Sets the path shown in pane `index`. */
const showIn = (layout: Layout, index: number, path: string | null): Layout => ({
  ...layout,
  panes: layout.panes.map((pane, i) => (i === index ? { ...pane, path } : pane)),
});
/** Focuses the other pane, adding an empty one on the right if there is only one. */
const split = (layout: Layout): Layout => ({
  ...layout,
  panes: layout.panes.length === 1 ? [...layout.panes, { id: crypto.randomUUID(), path: null }] : layout.panes,
  active: 1 - layout.active,
});
const withoutPane = (layout: Layout, index: number): Layout => ({ panes: layout.panes.filter((_, i) => i !== index), active: 0, ratio: 0.5 });

/** Slides the list open while the files travel down from the folder, and back up on close. */
const reveal = {
  initial: { height: 0, y: -12, opacity: 0, overflow: "hidden" },
  animate: { height: "auto", y: 0, opacity: 1, transitionEnd: { overflow: "visible" } },
  exit: { height: 0, y: -12, opacity: 0, overflow: "hidden" },
  transition: { duration: 0.2, ease },
} as const;

export default function App() {
  const { library: folders, edits } = useAssistant();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  /** Folder used for imports. */
  const [folderPath, setFolderPath] = useState<string | null>(null);
  const [layout, setLayoutState] = useState<Layout>(() => ({ panes: [{ id: crypto.randomUUID(), path: null }], active: 0, ratio: 0.5 }));
  // Menu commands and awaited dialogs act on the layout as it is by then.
  const layoutRef = useRef(layout);
  const setLayout = (change: (layout: Layout) => Layout) => {
    layoutRef.current = change(layoutRef.current);
    setLayoutState(layoutRef.current);
  };
  const views = useRef<Record<string, PaneHandle | null>>({});
  const [showingSidebar, setShowingSidebar] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);

  const promptDialog = useRef<HTMLDialogElement>(null);
  const promptInput = useRef<HTMLInputElement>(null);
  const [prompt, setPrompt] = useState({ title: "", confirm: "", value: "" });
  const alertDialog = useRef<HTMLDialogElement>(null);
  const [alertMessage, setAlertMessage] = useState("");

  const { panes, active, ratio } = layout;
  // Leaves room for the traffic lights outside fullscreen.
  const windowed = api.platform === "darwin" && !fullscreen;
  const filePath = panes[active].path;
  const view = () => views.current[layoutRef.current.panes[layoutRef.current.active].id];
  // The toolbar pills sit over the left pane, so only its PDFs need their background.
  const bare = !panes[0].path || fileType(panes[0].path) !== "pdf";
  /** Lets pending markdown and deck saves land before their file moves. */
  const flushEditors = () => Promise.all(Object.values(views.current).map((v) => v?.flush()));
  const toggleSidebar = () => setShowingSidebar((showing) => !showing);
  const expand = (folder: string) => setExpanded((expanded) => new Set(expanded).add(folder));
  const collapse = (folder: string) =>
    setExpanded((expanded) => {
      const next = new Set(expanded);
      next.delete(folder);
      return next;
    });

  // Listeners on window.smrt can't be removed, so they are added once and reach the latest render through this.
  const onCommand = useRef<(command: Command) => void>(null);
  onCommand.current = (command) => {
    const field = document.activeElement;
    const editable = (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) && !field.readOnly;
    if ((command === "undo" || command === "redo") && editable) {
      document.execCommand(command);
      return;
    }
    const commands: Partial<Record<Command, () => void>> = {
      toggleSidebar,
      toggleNotes: () => view()?.toggleNotes(),
      toggleSplit: () => (layoutRef.current.panes.length > 1 ? setLayout((l) => withoutPane(l, l.active)) : setLayout(split)),
      zoomIn: () => view()?.zoomIn(),
      zoomOut: () => view()?.zoomOut(),
      zoomReset: () => view()?.zoom(1),
      zoomFit: () => view()?.zoom(null),
      undo: () => view()?.undo(),
      redo: () => view()?.redo(),
    };
    commands[command]?.();
  };

  useEffect(() => {
    perform(reload);
    api.on("fullscreen", setFullscreen);
    api.on("command", (command) => onCommand.current?.(command));
    function onkeydown(event: KeyboardEvent) {
      const mod = api.platform === "darwin" ? event.metaKey : event.ctrlKey;
      if (mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "b" && !event.defaultPrevented) {
        event.preventDefault();
        toggleSidebar();
      }
    }
    window.addEventListener("keydown", onkeydown);
    return () => window.removeEventListener("keydown", onkeydown);
  }, []);

  // Lists the files the assistant creates.
  useEffect(() => {
    if (Object.keys(edits).length) perform(reload);
  }, [edits]);

  function showError(error: unknown) {
    setAlertMessage(String(error instanceof Error ? error.message : error).replace(/^Error invoking remote method '\w+': (Error: )?/, ""));
    alertDialog.current!.showModal();
  }

  async function perform(action: () => Promise<void>) {
    try {
      await action();
    } catch (error) {
      showError(error);
    }
  }

  function ask(title: string, confirm: string, value = ""): Promise<string | null> {
    const dialog = promptDialog.current!;
    flushSync(() => setPrompt({ title, confirm, value }));
    dialog.returnValue = "";
    dialog.showModal();
    promptInput.current!.focus();
    return new Promise((resolve) =>
      dialog.addEventListener("close", () => resolve(dialog.returnValue === "ok" ? promptInput.current!.value : null), { once: true }),
    );
  }

  async function reload() {
    assistant.set({ library: await api.listLibrary() });
  }

  async function newFolder() {
    const name = await ask("New Folder", "Create");
    if (name == null) return;
    await perform(async () => {
      const created = await api.createFolder(name);
      expand(created);
      setFolderPath(created);
      await reload();
    });
  }

  async function importInto(target: string | null) {
    await perform(async () => {
      if (!target) return;
      const imported = await api.importPDF(target);
      if (!imported) return;
      await reload();
      openFile(imported);
    });
  }

  async function newFile(target: string, type: "md" | "cards") {
    const name = await ask(type === "md" ? "New Markdown File" : "New Flashcard Deck", "Create");
    if (name == null) return;
    await perform(async () => {
      const created = await (type === "md" ? api.createMarkdown(target, name) : api.createDeck(target, name));
      await reload();
      openFile(created);
    });
  }

  /** Opens `path` in the active pane, or in the other one with `beside`; a file already open just gets focus. */
  function openFile(path: string, beside = false) {
    const parent = assistant.get().library.find((f) => filesOf(f).some((p) => p.path === path));
    setFolderPath(parent?.path ?? null);
    if (parent) expand(parent.path);
    remember([path, ...assistant.get().recent.filter((p) => p !== path)]);
    setLayout((layout) => {
      // Two panes on one file would overwrite each other's saves.
      const open = layout.panes.findIndex((p) => p.path === path);
      if (open >= 0) return { ...layout, active: open };
      const next = beside ? split(layout) : layout;
      return showIn(next, next.active, path);
    });
  }

  function remember(recent: string[]) {
    assistant.set({ recent: recent.slice(0, 20) });
    localStorage.setItem("recent", JSON.stringify(assistant.get().recent));
  }

  /** Gives the assistant the other pane, so it sits beside the file it was asked about. */
  function pinAssistant() {
    setLayout((layout) => {
      const next = split(layout);
      return showIn(next, next.active, null);
    });
  }

  /** Shows the assistant's start page, focusing a pane that already shows it. */
  function goHome() {
    setLayout((layout) => {
      const home = layout.panes.findIndex((p) => !p.path);
      return home >= 0 ? { ...layout, active: home } : showIn(layout, layout.active, null);
    });
  }

  function resize(event: PointerEvent<HTMLElement>) {
    const divider = event.currentTarget;
    const box = divider.parentElement!.getBoundingClientRect();
    let ratio = layoutRef.current.ratio;
    divider.setPointerCapture(event.pointerId);
    divider.onpointermove = (e) => {
      ratio = Math.min(0.9, Math.max(0.1, (e.clientX - box.left) / box.width));
      setLayout((layout) => ({ ...layout, ratio }));
    };
    // Dragging the divider to either edge closes the pane it squeezes, like in browsers.
    divider.onpointerup = () => {
      divider.onpointermove = null;
      if (ratio <= 0.15) setLayout((l) => withoutPane(l, 0));
      else if (ratio >= 0.85) setLayout((l) => withoutPane(l, 1));
    };
  }

  /** Closes the panes showing what `matches`, letting pending saves land first so they can't recreate it. */
  async function closeShowing(matches: (path: string) => boolean) {
    if (!layoutRef.current.panes.some((p) => p.path && matches(p.path))) return;
    await flushEditors();
    flushSync(() => setLayout((layout) => ({ ...layout, panes: layout.panes.map((p) => (p.path && matches(p.path) ? { ...p, path: null } : p)) })));
  }

  /** Moves the panes and recent files showing what `move` renames. */
  function follow(move: (path: string) => string) {
    setLayout((layout) => ({ ...layout, panes: layout.panes.map((p) => (p.path ? { ...p, path: move(p.path) } : p)) }));
    remember(assistant.get().recent.map(move));
  }

  async function fileMenu(file: File) {
    const choice = await contextMenu([
      ...(fileType(file.path) === "cards" ? [{ id: "edit", label: "Edit Cards" }] : []),
      { id: "split", label: "Open in Split View" },
      { type: "separator" as const },
      { id: "rename", label: "Rename…" },
      { id: "trash", label: "Move to Trash" },
    ]);
    if (choice === "edit") {
      flushSync(() => openFile(file.path));
      view()?.startEditing();
    } else if (choice === "split") {
      openFile(file.path, true);
    } else if (choice === "rename") {
      const titles = { md: "Rename Markdown File", cards: "Rename Deck", quiz: "Rename Quiz", html: "Rename HTML Page", pdf: "Rename PDF" };
      const name = await ask(titles[fileType(file.path)], "Rename", baseName(file.name));
      if (name == null) return;
      await perform(async () => {
        await flushEditors();
        const renamed = await api.renameFile(file.path, name);
        follow((p) => (p === file.path ? renamed : p));
        await reload();
      });
    } else if (choice === "trash") {
      await perform(async () => {
        await closeShowing((p) => p === file.path);
        await api.trashFile(file.path);
        await reload();
      });
    }
  }

  async function folderMenu(target: string) {
    const choice = await contextMenu([
      { id: "import", label: "Import PDF…" },
      { id: "markdown", label: "New Markdown File…" },
      { id: "deck", label: "New Flashcard Deck…" },
      { type: "separator" as const },
      { id: "rename", label: "Rename…" },
      { id: "trash", label: "Move to Trash" },
    ]);
    setFolderPath(target);
    if (choice === "import") await importInto(target);
    else if (choice === "markdown") await newFile(target, "md");
    else if (choice === "deck") await newFile(target, "cards");
    else if (choice === "rename") await renameFolder(target);
    else if (choice === "trash") await trashFolder(target);
  }

  async function renameFolder(target: string) {
    const name = await ask("Rename Folder", "Rename", folders.find((f) => f.path === target)?.name);
    if (name == null) return;
    await perform(async () => {
      await flushEditors();
      const renamed = await api.renameFolder(target, name);
      follow((p) => (inFolder(p, target) ? renamed + p.slice(target.length) : p));
      if (expanded.has(target)) {
        collapse(target);
        expand(renamed);
      }
      setFolderPath(renamed);
      await reload();
    });
  }

  async function trashFolder(target: string) {
    await perform(async () => {
      await closeShowing((p) => inFolder(p, target));
      await api.trashFolder(target);
      collapse(target);
      setFolderPath(null);
      remember(assistant.get().recent.filter((p) => !inFolder(p, target)));
      await reload();
    });
  }

  function toggleFolder(target: Folder) {
    setFolderPath(target.path);
    if (expanded.has(target.path)) collapse(target.path);
    else expand(target.path);
  }

  return (
    <>
      <main>
        <section id="reader">
          <div id="drag-strip"></div>
          <div id="reader-controls" className={`${windowed ? "windowed" : ""} ${showingSidebar ? "" : "floating"} ${bare ? "bare" : ""}`}>
            <IconButton name="home" title="Home" onClick={goHome} />
            <IconButton name="newFolder" title="New Folder" onClick={newFolder} />
            <IconButton name="add" title="Add to Folder" onClick={() => folderPath && folderMenu(folderPath)} disabled={!folderPath} />
          </div>
          <div id="sidebar-toggle" className={`${showingSidebar ? "" : "floating"} ${bare ? "bare" : ""}`}>
            <IconButton name="sidebar" title={showingSidebar ? "Hide Sidebar" : "Show Sidebar"} onClick={toggleSidebar} />
          </div>
          <aside id="sidebar" className={showingSidebar ? undefined : "hidden"}>
            {folders.length === 0 ? (
              <EmptyState icon="newFolder" title="Create a folder" action={{ label: "New Folder", run: newFolder }} />
            ) : (
              <ul role="tree">
                {folders.map((f) => {
                  const open = expanded.has(f.path);
                  const selected = folderPath === f.path && !filePath;
                  return (
                    <li key={f.path} role="treeitem" aria-expanded={open} aria-selected={selected}>
                      <button className={`row ${selected ? "selected" : ""}`} onClick={() => toggleFolder(f)} onContextMenu={() => folderMenu(f.path)}>
                        <span className={`chevron ${open ? "open" : ""}`}>
                          <Icon name="chevronRight" size={12} />
                        </span>
                        <span className="label">{f.name}</span>
                      </button>
                      <AnimatePresence initial={false}>
                        {open && (
                          <motion.ul role="group" {...reveal}>
                            {filesOf(f)
                              .sort(byName)
                              .map((file) => (
                                <li key={file.path} role="treeitem" aria-selected={filePath === file.path}>
                                  <button
                                    className={`row file ${filePath === file.path ? "selected" : ""}`}
                                    onClick={() => openFile(file.path)}
                                    onContextMenu={() => fileMenu(file)}
                                  >
                                    <FileIcon type={fileType(file.path)} size={22} />
                                    <span className="label">{file.name}</span>
                                  </button>
                                </li>
                              ))}
                          </motion.ul>
                        )}
                      </AnimatePresence>
                    </li>
                  );
                })}
              </ul>
            )}
          </aside>
          <div id="document">
            {panes.map((pane, index) => (
              <Fragment key={pane.id}>
                {index > 0 && <div className="divider" role="separator" aria-orientation="vertical" onPointerDown={resize}></div>}
                <div
                  className="pane"
                  style={{ flex: `${panes.length > 1 ? (index === 0 ? ratio : 1 - ratio) : 1} 1 0` }}
                  onPointerDownCapture={() => layoutRef.current.active !== index && setLayout((layout) => ({ ...layout, active: index }))}
                >
                  <Pane
                    ref={(handle) => void (views.current[pane.id] = handle)}
                    path={pane.path}
                    context={pane.path ?? panes.find((p) => p.path)?.path ?? null}
                    docked={panes.every((p) => p.path)}
                    active={index === active}
                    inset={index === 0 && showingSidebar ? SIDEBAR_INSET : 0}
                    onerror={showError}
                    onopen={openFile}
                    onpin={pinAssistant}
                  />
                </div>
              </Fragment>
            ))}
          </div>
        </section>
      </main>

      <ContextMenu />

      <dialog ref={promptDialog}>
        <form method="dialog">
          <h2>{prompt.title}</h2>
          <input required ref={promptInput} value={prompt.value} onChange={(event) => setPrompt({ ...prompt, value: event.target.value })} />
          <div className="buttons">
            <button value="ok" className="primary">
              {prompt.confirm}
            </button>
            <button value="cancel" formNoValidate>
              Cancel
            </button>
          </div>
        </form>
      </dialog>

      <dialog ref={alertDialog}>
        <form method="dialog">
          <h2>Something went wrong</h2>
          <p>{alertMessage}</p>
          <div className="buttons">
            <button className="primary">OK</button>
          </div>
        </form>
      </dialog>
    </>
  );
}
