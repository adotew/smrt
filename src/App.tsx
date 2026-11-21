import { createContext, useContext, useEffect, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import {
  DockviewReact,
  themeLight,
  type DockviewApi,
  type DockviewReadyEvent,
  type IDockviewPanelHeaderProps,
  type IDockviewPanelProps,
} from "dockview-react";
import type { Command } from "../electron/main.ts";
import type { Folder } from "../electron/library.ts";
import ContextMenu, { contextMenu } from "./components/ContextMenu.tsx";
import EmptyState from "./components/EmptyState.tsx";
import FileIcon from "./components/FileIcon.tsx";
import Icon, { IconButton } from "./components/Icon.tsx";
import { assistant, useAssistant } from "./lib/assistant.ts";
import Pane, { fileType, type PaneHandle } from "./components/Pane.tsx";
import { ease } from "./lib/transitions.ts";
import Assistant from "./views/Assistant.tsx";

const api = window.smrt;

type File = Folder["pdfs"][number];

const baseName = (name: string) => name.replace(/\.(pdf|md|cards|quiz|html)$/i, "");
const title = (path: string) => baseName(path.split(/[\\/]/).pop()!);
const byName = (a: File, b: File) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
const filesOf = (folder: Folder) => [...folder.pdfs, ...folder.markdown, ...folder.decks, ...folder.quizzes, ...folder.html];
const inFolder = (file: string, folder: string) => file.startsWith(folder) && /[\\/]/.test(file[folder.length] ?? "");
const pathOf = (panel: { params?: Record<string, unknown> }) => panel.params?.path as string;

/** Dockview's light theme, recoloured from app.css so it follows dark mode too. */
const theme = { ...themeLight, className: "dockview-theme-light dock-theme" };

/** Slides the list open while the files travel down from the folder, and back up on close. */
const reveal = {
  initial: { height: 0, y: -12, opacity: 0, overflow: "hidden" },
  animate: { height: "auto", y: 0, opacity: 1, transitionEnd: { overflow: "visible" } },
  exit: { height: 0, y: -12, opacity: 0, overflow: "hidden" },
  transition: { duration: 0.2, ease },
} as const;

/** What the dock's panels need from App; dockview renders them outside App's props. */
const Panes = createContext<{
  views: RefObject<Record<string, PaneHandle | null>>;
  active: string | null;
  onerror: (error: unknown) => void;
}>(null!);

function FilePanel({ api: panel, params }: IDockviewPanelProps<{ path: string }>) {
  const { views, active, onerror } = useContext(Panes);
  return (
    <div className="pane">
      <Pane ref={(handle) => void (views.current[panel.id] = handle)} path={params.path} active={panel.id === active} onerror={onerror} />
    </div>
  );
}

const components = { file: FilePanel };

/** File tab with its icon before its name (as in VS Code), middle-click closing, and a Solar close button. */
function FileTab({ api: panel, params }: IDockviewPanelHeaderProps<{ path: string }>) {
  const [name, setName] = useState(panel.title ?? "");
  const middle = useRef(false);

  useEffect(() => {
    setName(panel.title ?? "");
    const disposable = panel.onDidTitleChange((event) => setName(event.title));
    return () => disposable.dispose();
  }, [panel]);

  return (
    <div
      className="dv-default-tab file-tab"
      onPointerDown={(event) => {
        middle.current = event.button === 1;
      }}
      onPointerUp={(event) => {
        if (middle.current && event.button === 1) {
          middle.current = false;
          event.preventDefault();
          panel.close();
        }
      }}
      onPointerLeave={() => {
        middle.current = false;
      }}
    >
      <FileIcon type={fileType(params.path)} size={16} />
      <span className="dv-default-tab-content">{name}</span>
      <button
        type="button"
        className="dv-default-tab-action"
        aria-label="Close tab"
        onPointerDown={(event) => event.preventDefault()}
        onClick={(event) => {
          event.preventDefault();
          panel.close();
        }}
      >
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}
const Watermark = () => (
  <>
    <div className="drag-strip"></div>
    <EmptyState icon="document" title="No file open" description="Pick one from the library." />
  </>
);

export default function App() {
  const { library: folders, edits } = useAssistant();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  /** Folder used for imports. */
  const [folderPath, setFolderPath] = useState<string | null>(null);
  const dock = useRef<DockviewApi>(null);
  /** The active panel's id and file, which the sidebar, assistant and menu commands follow. */
  const [active, setActive] = useState<{ id: string; path: string } | null>(null);
  const views = useRef<Record<string, PaneHandle | null>>({});
  const [showingSidebar, setShowingSidebar] = useState(true);
  const [showingAssistant, setShowingAssistant] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);

  const promptDialog = useRef<HTMLDialogElement>(null);
  const promptInput = useRef<HTMLInputElement>(null);
  const [prompt, setPrompt] = useState({ title: "", confirm: "", value: "" });
  const alertDialog = useRef<HTMLDialogElement>(null);
  const [alertMessage, setAlertMessage] = useState("");

  // Leaves room for the traffic lights outside fullscreen.
  const windowed = api.platform === "darwin" && !fullscreen;
  const filePath = active?.path ?? null;
  const panels = () => dock.current?.panels ?? [];
  const view = () => {
    const id = dock.current?.activePanel?.id;
    return id ? views.current[id] : null;
  };
  /** Lets pending markdown and deck saves land before their file moves. */
  const flushEditors = () => Promise.all(Object.values(views.current).map((v) => v?.flush()));
  const saveLayout = () => dock.current && localStorage.setItem("layout", JSON.stringify(dock.current.toJSON()));
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
      toggleSplit,
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
    perform(async () => {
      await reload();
      restoreLayout();
    });
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

  function onReady({ api: dockApi }: DockviewReadyEvent) {
    dock.current = dockApi;
    dockApi.onDidActivePanelChange(({ panel }) => setActive(panel ? { id: panel.id, path: pathOf(panel) } : null));
    dockApi.onDidLayoutChange(saveLayout);
  }

  /** Reopens the last session's layout, leaving out files that have gone since. */
  function restoreLayout() {
    const saved = localStorage.getItem("layout");
    if (!saved || !dock.current) return;
    try {
      dock.current.fromJSON(JSON.parse(saved));
    } catch {
      dock.current.clear();
    }
    const existing = new Set(assistant.get().library.flatMap((f) => filesOf(f).map((file) => file.path)));
    for (const panel of panels().filter((p) => !existing.has(pathOf(p)))) panel.api.close();
  }

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

  /** Opens `path` as a tab in the active group, or in a new group to its right with `beside`; a file already open just gets focus. */
  function openFile(path: string, beside = false) {
    const parent = assistant.get().library.find((f) => filesOf(f).some((p) => p.path === path));
    setFolderPath(parent?.path ?? null);
    if (parent) expand(parent.path);
    remember([path, ...assistant.get().recent.filter((p) => p !== path)]);
    const dockApi = dock.current;
    if (!dockApi) return;
    // Two panels on one file would overwrite each other's saves.
    const open = panels().find((p) => pathOf(p) === path);
    if (open) return open.api.setActive();
    const group = dockApi.activeGroup;
    dockApi.addPanel({
      id: crypto.randomUUID(),
      component: "file",
      title: title(path),
      params: { path },
      ...(beside && group && { position: { referenceGroup: group, direction: "right" } }),
    });
  }

  /** Moves the active file into a group of its own on the right, or gathers every file back into one group. */
  function toggleSplit() {
    const dockApi = dock.current;
    const panel = dockApi?.activePanel;
    if (!dockApi || !panel) return;
    if (dockApi.groups.length > 1) {
      const target = dockApi.groups[0];
      for (const p of panels()) if (p.group !== target) p.api.moveTo({ group: target });
      panel.api.setActive();
    } else if (panel.group.panels.length > 1) {
      panel.api.moveTo({ group: panel.group, position: "right" });
    }
  }

  function remember(recent: string[]) {
    assistant.set({ recent: recent.slice(0, 20) });
    localStorage.setItem("recent", JSON.stringify(assistant.get().recent));
  }

  /** Closes the panels showing what `matches`, letting pending saves land first so they can't recreate it. */
  async function closeShowing(matches: (path: string) => boolean) {
    const showing = panels().filter((p) => matches(pathOf(p)));
    if (!showing.length) return;
    await flushEditors();
    flushSync(() => showing.forEach((p) => p.api.close()));
  }

  /** Moves the panels and recent files showing what `move` renames. */
  function follow(move: (path: string) => string) {
    for (const panel of panels()) {
      const path = move(pathOf(panel));
      if (path === pathOf(panel)) continue;
      panel.api.updateParameters({ path });
      panel.api.setTitle(title(path));
    }
    const current = dock.current?.activePanel;
    if (current) setActive({ id: current.id, path: pathOf(current) });
    saveLayout();
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
      <main className={`${windowed ? "windowed" : ""} ${showingSidebar ? "" : "sidebar-hidden"} ${showingAssistant ? "" : "assistant-hidden"}`}>
        <aside id="sidebar" hidden={!showingSidebar}>
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
        <section id="dock">
          <Panes.Provider value={{ views, active: active?.id ?? null, onerror: showError }}>
            <DockviewReact
              components={components}
              defaultTabComponent={FileTab}
              watermarkComponent={Watermark}
              onReady={onReady}
              theme={theme}
              defaultRenderer="always"
              disableFloatingGroups
            />
          </Panes.Provider>
        </section>
        <aside id="assistant" hidden={!showingAssistant}>
          <Assistant context={filePath} open={showingAssistant} onOpenChange={setShowingAssistant} onopen={openFile} />
        </aside>
        {/* Rendered after #dock so Electron's DOM-order app-region hit test keeps these buttons clickable over drag regions. */}
        <div id="window-controls">
          <IconButton name="sidebar" size={16} title={showingSidebar ? "Hide Sidebar" : "Show Sidebar"} onClick={toggleSidebar} />
          {showingSidebar && (
            <>
              <IconButton name="newFolder" size={16} title="New Folder" onClick={newFolder} />
              <IconButton name="add" size={16} title="Add to Folder" onClick={() => folderPath && folderMenu(folderPath)} disabled={!folderPath} />
            </>
          )}
        </div>
        {!showingAssistant && (
          <div id="assistant-toggle">
            <IconButton name="sparkles" size={16} title="Assistant (⌘J)" onClick={() => setShowingAssistant(true)} />
          </div>
        )}
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
