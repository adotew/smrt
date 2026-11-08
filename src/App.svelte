<script lang="ts">
  import { onMount, tick } from "svelte";
  import { cubicOut } from "svelte/easing";
  import { slide } from "svelte/transition";
  import { SvelteSet } from "svelte/reactivity";
  import type { Folder } from "../electron/library.ts";
  import ContextMenu, { contextMenu } from "./ContextMenu.svelte";
  import EmptyState from "./EmptyState.svelte";
  import FileIcon from "./FileIcon.svelte";
  import Icon, { type IconName } from "./Icon.svelte";
  import Pane from "./Pane.svelte";

  const api = window.smrt;

  type File = Folder["pdfs"][number];

  /** The floating sidebar's width plus its margin and the gap beside it; matches `#sidebar` in app.css. */
  const SIDEBAR_INSET = 256;

  let folders: Folder[] = $state([]);
  let expanded = new SvelteSet<string>();
  /** Folder used for imports. */
  let folderPath: string | null = $state(null);
  /** One pane, or two side by side; each shows a PDF, markdown file or deck. */
  let panes: { id: string; path: string | null }[] = $state([{ id: crypto.randomUUID(), path: null }]);
  /** Index of the pane the sidebar and menu commands act on. */
  let active = $state(0);
  /** The left pane's share of the width in split view. */
  let ratio = $state(0.5);
  const views: Record<string, Pane | undefined> = {};
  let showingSidebar = $state(true);
  let fullscreen = $state(false);

  let promptDialog: HTMLDialogElement;
  let prompt = $state({ title: "", confirm: "", value: "" });
  let alertDialog: HTMLDialogElement;
  let alertMessage = $state("");

  // Leaves room for the traffic lights outside fullscreen.
  const windowed = $derived(api.platform === "darwin" && !fullscreen);
  const fileType = (path: string) => (/\.md$/i.test(path) ? "md" : /\.cards$/i.test(path) ? "cards" : "pdf");
  const filePath = $derived(panes[active].path);
  const view = () => views[panes[active].id];
  // The toolbar pills sit over the left pane, so only its PDFs need their background.
  const bare = $derived(!panes[0].path || fileType(panes[0].path) !== "pdf");
  /** Lets pending markdown and deck saves land before their file moves. */
  const flushEditors = () => Promise.all(Object.values(views).map((v) => v?.flush()));
  /** Slides the list open while the files travel down from the folder, and back up on close. */
  function reveal(node: Element) {
    const { css } = slide(node, { duration: 200 });
    return {
      duration: 200,
      easing: cubicOut,
      css: (t: number, u: number) => `${css?.(t, u)}; transform: translateY(${-u * 12}px); opacity: ${t}`,
    };
  }

  const baseName = (name: string) => name.replace(/\.(pdf|md|cards)$/i, "");
  const byName = (a: File, b: File) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });

  onMount(() => perform(reload));

  api.on("fullscreen", (value) => (fullscreen = value));
  api.on("command", (command) => {
    const field = document.activeElement;
    const editable = (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) && !field.readOnly;
    if ((command === "undo" || command === "redo") && editable) {
      document.execCommand(command);
      return;
    }
    const commands: Partial<Record<typeof command, () => void>> = {
      toggleSidebar: () => (showingSidebar = !showingSidebar),
      toggleNotes: () => view()?.toggleNotes(),
      toggleSplit: () => (panes.length > 1 ? closePane(active) : splitPane()),
      zoomIn: () => view()?.zoomIn(),
      zoomOut: () => view()?.zoomOut(),
      zoomReset: () => view()?.zoom(1),
      zoomFit: () => view()?.zoom(null),
      undo: () => view()?.undo(),
      redo: () => view()?.redo(),
    };
    commands[command]?.();
  });

  function showError(error: unknown) {
    alertMessage = String(error instanceof Error ? error.message : error).replace(/^Error invoking remote method '\w+': (Error: )?/, "");
    alertDialog.showModal();
  }

  async function perform(action: () => Promise<void>) {
    try {
      await action();
    } catch (error) {
      showError(error);
    }
  }

  function ask(title: string, confirm: string, value = ""): Promise<string | null> {
    prompt = { title, confirm, value };
    promptDialog.returnValue = "";
    promptDialog.showModal();
    return new Promise((resolve) =>
      promptDialog.addEventListener("close", () => resolve(promptDialog.returnValue === "ok" ? prompt.value : null), {
        once: true,
      }),
    );
  }

  async function reload() {
    folders = await api.listLibrary();
  }

  async function newFolder() {
    const name = await ask("New Folder", "Create");
    if (name == null) return;
    await perform(async () => {
      const created = await api.createFolder(name);
      expanded.add(created);
      folderPath = created;
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
    const parent = folders.find((f) => [...f.pdfs, ...f.markdown, ...f.decks].some((p) => p.path === path));
    folderPath = parent?.path ?? null;
    if (parent) expanded.add(parent.path);
    // Two panes on one file would overwrite each other's saves.
    const open = panes.findIndex((p) => p.path === path);
    if (open >= 0) {
      active = open;
      return;
    }
    if (beside) splitPane();
    panes[active].path = path;
  }

  /** Focuses the other pane, adding an empty one on the right if there is only one. */
  function splitPane() {
    if (panes.length === 1) panes.push({ id: crypto.randomUUID(), path: null });
    active = 1 - active;
  }

  function closePane(index: number) {
    panes.splice(index, 1);
    active = 0;
    ratio = 0.5;
  }

  function resize(event: PointerEvent & { currentTarget: HTMLElement }) {
    const divider = event.currentTarget;
    const box = divider.parentElement!.getBoundingClientRect();
    divider.setPointerCapture(event.pointerId);
    divider.onpointermove = (e) => (ratio = Math.min(0.9, Math.max(0.1, (e.clientX - box.left) / box.width)));
    // Dragging the divider to either edge closes the pane it squeezes, like in browsers.
    divider.onpointerup = () => {
      divider.onpointermove = null;
      if (ratio <= 0.15) closePane(0);
      else if (ratio >= 0.85) closePane(1);
    };
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
      openFile(file.path);
      await tick();
      view()?.startEditing();
    } else if (choice === "split") {
      openFile(file.path, true);
    } else if (choice === "rename") {
      const titles = { md: "Rename Markdown File", cards: "Rename Deck", pdf: "Rename PDF" };
      const name = await ask(titles[fileType(file.path)], "Rename", baseName(file.name));
      if (name == null) return;
      await perform(async () => {
        await flushEditors();
        const renamed = await api.renameFile(file.path, name);
        for (const pane of panes) if (pane.path === file.path) pane.path = renamed;
        await reload();
      });
    } else if (choice === "trash") {
      await perform(async () => {
        // Closing first lets pending saves land before the file moves, so they can't recreate it.
        const showing = panes.filter((p) => p.path === file.path);
        if (showing.length) {
          await flushEditors();
          for (const pane of showing) pane.path = null;
          await tick();
        }
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
    ]);
    folderPath = target;
    if (choice === "import") await importInto(target);
    else if (choice === "markdown") await newFile(target, "md");
    else if (choice === "deck") await newFile(target, "cards");
  }

  function toggleFolder(target: Folder) {
    folderPath = target.path;
    if (expanded.has(target.path)) expanded.delete(target.path);
    else expanded.add(target.path);
  }
</script>

{#snippet iconButton(
  name: IconName,
  title: string,
  onclick: () => void,
  disabled = false,
  pressed: boolean | undefined = undefined,
)}
  <button class="icon-button" class:active={pressed} {title} aria-label={title} aria-pressed={pressed} {onclick} {disabled}>
    <Icon {name} />
  </button>
{/snippet}

<main>
  <section id="reader">
    <div id="drag-strip"></div>
    <div id="reader-controls" class:windowed class:floating={!showingSidebar} class:bare>
      {@render iconButton("newFolder", "New Folder", newFolder)}
      {@render iconButton("add", "Add to Folder", () => folderPath && folderMenu(folderPath), !folderPath)}
    </div>
    <div id="sidebar-toggle" class:floating={!showingSidebar} class:bare>
      {@render iconButton("sidebar", showingSidebar ? "Hide Sidebar" : "Show Sidebar", () => (showingSidebar = !showingSidebar))}
    </div>
    <aside id="sidebar" class:hidden={!showingSidebar}>
        {#if folders.length === 0}
          <EmptyState icon="newFolder" title="Create a folder" action={{ label: "New Folder", run: newFolder }} />
        {:else}
          <ul role="tree">
            {#each folders as f (f.path)}
              {@const open = expanded.has(f.path)}
              <li role="treeitem" aria-expanded={open} aria-selected={folderPath === f.path && !filePath}>
                <button
                  class="row"
                  class:selected={folderPath === f.path && !filePath}
                  onclick={() => toggleFolder(f)}
                  oncontextmenu={() => folderMenu(f.path)}
                >
                  <span class="chevron" class:open><Icon name="chevronRight" size={12} /></span>
                  <span class="label">{f.name}</span>
                </button>
                {#if open}
                  <ul role="group" transition:reveal>
                    {#each [...f.pdfs, ...f.markdown, ...f.decks].sort(byName) as file (file.path)}
                      <li role="treeitem" aria-selected={filePath === file.path}>
                        <button
                          class="row file"
                          class:selected={filePath === file.path}
                          onclick={() => openFile(file.path)}
                          oncontextmenu={() => fileMenu(file)}
                        >
                          <FileIcon type={fileType(file.path)} size={22} />
                          <span class="label">{file.name}</span>
                        </button>
                      </li>
                    {/each}
                  </ul>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
    </aside>
    <div id="document">
      {#each panes as pane, index (pane.id)}
        {#if index > 0}
          <div class="divider" role="separator" aria-orientation="vertical" onpointerdown={resize}></div>
        {/if}
        <div
          class="pane"
          style:flex="{panes.length > 1 ? (index === 0 ? ratio : 1 - ratio) : 1} 1 0"
          onpointerdowncapture={() => (active = index)}
        >
          <Pane
            bind:this={views[pane.id]}
            path={pane.path}
            active={index === active}
            inset={index === 0 && showingSidebar ? SIDEBAR_INSET : 0}
            onerror={showError}
            {iconButton}
          />
        </div>
      {/each}
    </div>
  </section>
</main>

<ContextMenu />

<dialog bind:this={promptDialog}>
  <form method="dialog">
    <h2>{prompt.title}</h2>
    <!-- svelte-ignore a11y_autofocus -->
    <input required autofocus bind:value={prompt.value} />
    <div class="buttons">
      <button value="ok" class="primary">{prompt.confirm}</button>
      <button value="cancel" formnovalidate>Cancel</button>
    </div>
  </form>
</dialog>

<dialog bind:this={alertDialog}>
  <form method="dialog">
    <h2>Something went wrong</h2>
    <p>{alertMessage}</p>
    <div class="buttons"><button class="primary">OK</button></div>
  </form>
</dialog>
