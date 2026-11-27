import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { flushSync } from "react-dom";
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
import { Button } from "./components/ui/button.tsx";
import ContextMenu, { contextMenu } from "./components/ContextMenu.tsx";
import EmptyState from "./components/EmptyState.tsx";
import FileIcon from "./components/FileIcon.tsx";
import FileTree, { addToFolder, addToFolderItems } from "./components/FileTree.tsx";
import Icon, { IconButton } from "./components/Icon.tsx";
import { allFiles, assistant, useAssistant } from "./lib/assistant.ts";
import Pane, { fileType, type PaneHandle } from "./components/Pane.tsx";
import QuickOpen from "./components/QuickOpen.tsx";
import Assistant from "./views/Assistant.tsx";

const api = window.smrt;

const SIDEBAR = { key: "sidebarWidth", fallback: 240, min: 180, max: 480 } as const;
const ASSISTANT = { key: "assistantWidth", fallback: 380, min: 280, max: 720 } as const;
const MIN_DOCK = 240;

function readWidth({ key, fallback, min, max }: { key: string; fallback: number; min: number; max: number }) {
  const parsed = Number(localStorage.getItem(key));
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(max, Math.max(min, parsed)) : fallback;
}

const baseName = (name: string) => name.replace(/\.(pdf|md|cards|quiz|html)$/i, "");
const title = (path: string) => baseName(path.split(/[\\/]/).pop()!);
const inFolder = (file: string, folder: string) => file.startsWith(folder) && /[\\/]/.test(file[folder.length] ?? "");
const pathOf = (panel: { params?: Record<string, unknown> }) => panel.params?.path as string;

/** Returns every ancestor folder path of `target` in `folders`, outermost first. */
function ancestorFolders(folders: Folder[], target: string): string[] {
  for (const folder of folders) {
    if (folder.path === target) return [folder.path];
    if (inFolder(target, folder.path)) {
      return [folder.path, ...ancestorFolders(folder.folders, target)];
    }
  }
  return [];
}

/** Dockview's light theme, recoloured from app.css so it follows dark mode too. */
const theme = { ...themeLight, className: "dockview-theme-light dock-theme" };

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
  const [expanded, setExpanded] = useState<string[]>([]);
  /** Folder used for imports. */
  const [folderPath, setFolderPath] = useState<string | null>(null);
  const dock = useRef<DockviewApi>(null);
  /** The active panel's id and file, which the sidebar, assistant and menu commands follow. */
  const [active, setActive] = useState<{ id: string; path: string } | null>(null);
  const views = useRef<Record<string, PaneHandle | null>>({});
  const [showingSidebar, setShowingSidebar] = useState(true);
  const [showingAssistant, setShowingAssistant] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(() => readWidth(SIDEBAR));
  const [assistantWidth, setAssistantWidth] = useState(() => readWidth(ASSISTANT));
  const [resizing, setResizing] = useState<"sidebar" | "assistant" | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [quickOpening, setQuickOpening] = useState(false);
  const main = useRef<HTMLElement>(null);

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
  const expand = (...paths: string[]) =>
    setExpanded((prev) => {
      const next = [...prev];
      for (const p of paths) if (p && !next.includes(p)) next.push(p);
      return next.length === prev.length ? prev : next;
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
      find: () => view()?.find(),
      quickOpen: () => setQuickOpening(true),
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
    const existing = new Set(allFiles(assistant.get().library).map((file) => file.path));
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

  async function newFolder(parent?: string) {
    const name = await ask("New Folder", "Create");
    if (name == null) return;
    await perform(async () => {
      const created = await api.createFolder(name, parent);
      expand(...(parent ? [parent] : []), created);
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
    const library = assistant.get().library;
    const match = allFiles(library).find((p) => p.path === path);
    setFolderPath(match?.folderPath ?? null);
    if (match) expand(...ancestorFolders(library, match.folderPath));
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

  function rewritePath(path: string, from: string, to: string) {
    if (path === from) return to;
    if (inFolder(path, from)) return to + path.slice(from.length);
    return path;
  }

  async function renameItem(target: string, kind: "folder" | "file", name: string) {
    await perform(async () => {
      await flushEditors();
      const renamed = kind === "folder" ? await api.renameFolder(target, name) : await api.renameFile(target, name);
      if (renamed === target) return;
      follow((p) => rewritePath(p, target, renamed));
      if (kind === "folder") {
        setExpanded((prev) => prev.map((p) => rewritePath(p, target, renamed)));
        setFolderPath((prev) => (prev ? rewritePath(prev, target, renamed) : prev));
      }
      await reload();
    });
  }

  async function moveItems(sources: string[], targetFolder: string | null) {
    await perform(async () => {
      await flushEditors();
      const moves: [string, string][] = [];
      try {
        for (const source of sources) {
          const destination = await api.move(source, targetFolder);
          if (destination !== source) moves.push([source, destination]);
        }
      } finally {
        // Items moved before a failure still need their tabs and paths updated.
        if (moves.length) {
          const remap = (p: string) => moves.reduce((acc, [from, to]) => rewritePath(acc, from, to), p);
          follow(remap);
          setExpanded((prev) => prev.map(remap));
          setFolderPath((prev) => (prev ? remap(prev) : prev));
          await reload();
        }
      }
    });
  }

  async function dropExternalFiles(files: File[], targetFolder: string) {
    await perform(async () => {
      let lastImported: string | null = null;
      try {
        for (const file of files) lastImported = await api.importDroppedPDF(file, targetFolder);
      } finally {
        await reload();
      }
      if (lastImported) openFile(lastImported);
    });
  }

  async function trashItems(targets: { path: string; kind: "folder" | "file" }[]) {
    await perform(async () => {
      const matches = (p: string) =>
        targets.some((t) => p === t.path || (t.kind === "folder" && inFolder(p, t.path)));
      await closeShowing(matches);
      try {
        for (const target of targets) {
          if (target.kind === "folder") await api.trashFolder(target.path);
          else await api.trashFile(target.path);
        }
      } finally {
        await reload();
      }
      setExpanded((prev) => prev.filter((p) => !matches(p)));
      setFolderPath((prev) => (prev && matches(prev) ? null : prev));
      remember(assistant.get().recent.filter((p) => !matches(p)));
    });
  }

  async function addMenu(target: string) {
    const choice = await contextMenu(addToFolderItems);
    addToFolder(choice, target, { onNewFolder: newFolder, onImportPDF: importInto, onNewFile: newFile });
  }

  function startResize(side: "sidebar" | "assistant", event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);

    const config = side === "sidebar" ? SIDEBAR : ASSISTANT;
    const startX = event.clientX;
    const startWidth = side === "sidebar" ? sidebarWidth : assistantWidth;
    const otherWidth = side === "sidebar" ? (showingAssistant ? assistantWidth : 0) : showingSidebar ? sidebarWidth : 0;
    const containerWidth = main.current?.clientWidth ?? window.innerWidth;
    const max = Math.max(config.min, Math.min(config.max, containerWidth - otherWidth - MIN_DOCK));
    let latest = startWidth;

    setResizing(side);

    function onMove(move: PointerEvent) {
      const delta = side === "sidebar" ? move.clientX - startX : startX - move.clientX;
      latest = Math.round(Math.min(max, Math.max(config.min, startWidth + delta)));
      if (side === "sidebar") setSidebarWidth(latest);
      else setAssistantWidth(latest);
    }

    function onEnd() {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onEnd);
      handle.removeEventListener("pointercancel", onEnd);
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
      setResizing(null);
      localStorage.setItem(config.key, String(latest));
    }

    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onEnd);
    handle.addEventListener("pointercancel", onEnd);
  }

  function resetWidth(side: "sidebar" | "assistant") {
    const config = side === "sidebar" ? SIDEBAR : ASSISTANT;
    if (side === "sidebar") setSidebarWidth(config.fallback);
    else setAssistantWidth(config.fallback);
    localStorage.setItem(config.key, String(config.fallback));
  }

  return (
    <>
      <main
        ref={main}
        className={`${windowed ? "windowed" : ""} ${showingSidebar ? "" : "sidebar-hidden"} ${showingAssistant ? "" : "assistant-hidden"} ${resizing ? "resizing" : ""}`}
        style={{ "--sidebar-width": `${sidebarWidth}px`, "--assistant-width": `${assistantWidth}px` } as CSSProperties}
      >
        <aside id="sidebar" hidden={!showingSidebar}>
          <FileTree
            folders={folders}
            expanded={expanded}
            onExpandedChange={setExpanded}
            activeFile={filePath}
            onSelectFolder={setFolderPath}
            onOpenFile={openFile}
            onRename={renameItem}
            onMove={moveItems}
            onDropExternalFiles={dropExternalFiles}
            onTrash={trashItems}
            onNewFolder={newFolder}
            onImportPDF={importInto}
            onNewFile={newFile}
            onEditCards={(path) => {
              flushSync(() => openFile(path));
              view()?.startEditing();
            }}
          />
        </aside>
        {showingSidebar && (
          <div
            className={`resize-sash ${resizing === "sidebar" ? "active" : ""}`}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize sidebar"
            aria-valuenow={sidebarWidth}
            aria-valuemin={SIDEBAR.min}
            aria-valuemax={SIDEBAR.max}
            onPointerDown={(event) => startResize("sidebar", event)}
            onDoubleClick={() => resetWidth("sidebar")}
          />
        )}
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
        {showingAssistant && (
          <div
            className={`resize-sash ${resizing === "assistant" ? "active" : ""}`}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize assistant"
            aria-valuenow={assistantWidth}
            aria-valuemin={ASSISTANT.min}
            aria-valuemax={ASSISTANT.max}
            onPointerDown={(event) => startResize("assistant", event)}
            onDoubleClick={() => resetWidth("assistant")}
          />
        )}
        <aside id="assistant" hidden={!showingAssistant}>
          <Assistant context={filePath} open={showingAssistant} onOpenChange={setShowingAssistant} onopen={openFile} />
        </aside>
        {/* Rendered after #dock so Electron's DOM-order app-region hit test keeps these buttons clickable over drag regions. */}
        <div id="window-controls">
          <IconButton name="sidebar" size={16} title={showingSidebar ? "Hide Sidebar" : "Show Sidebar"} onClick={toggleSidebar} />
          {showingSidebar && (
            <>
              <IconButton name="newFolder" size={16} title="New Folder" onClick={() => newFolder()} />
              <IconButton name="add" size={16} title="Add to Folder" onClick={() => folderPath && addMenu(folderPath)} disabled={!folderPath} />
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
      <QuickOpen open={quickOpening} onClose={() => setQuickOpening(false)} onOpen={openFile} />

      <dialog
        ref={promptDialog}
        onClick={(event) => {
          if (event.target === event.currentTarget) event.currentTarget.close("cancel");
        }}
      >
        <form method="dialog">
          <h2>{prompt.title}</h2>
          <input
            required
            ref={promptInput}
            placeholder="Name"
            value={prompt.value}
            onChange={(event) => setPrompt({ ...prompt, value: event.target.value })}
          />
          <div className="buttons">
            <Button type="submit" size="sm" value="ok">
              {prompt.confirm}
            </Button>
            <Button type="submit" variant="ghost" size="sm" value="cancel" formNoValidate>
              Cancel
            </Button>
          </div>
        </form>
      </dialog>

      <dialog
        ref={alertDialog}
        onClick={(event) => {
          if (event.target === event.currentTarget) event.currentTarget.close();
        }}
      >
        <form method="dialog">
          <h2>Something went wrong</h2>
          <p>{alertMessage}</p>
          <div className="buttons">
            <Button type="submit" size="sm">
              OK
            </Button>
          </div>
        </form>
      </dialog>
    </>
  );
}
