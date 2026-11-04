<script lang="ts">
  import { onMount } from "svelte";
  import { cubicOut } from "svelte/easing";
  import { slide } from "svelte/transition";
  import { SvelteSet } from "svelte/reactivity";
  import type { Folder } from "../electron/library.ts";
  import EmptyState from "./EmptyState.svelte";
  import Icon, { type IconName } from "./Icon.svelte";
  import Reader from "./Reader.svelte";

  const api = window.smrt;

  type PDF = Folder["pdfs"][number];

  /** The floating sidebar's width plus its margin and the gap beside it; matches `#sidebar` in app.css. */
  const SIDEBAR_INSET = 256;

  let folders: Folder[] = $state([]);
  let expanded = new SvelteSet<string>();
  /** Folder used for imports. */
  let folderPath: string | null = $state(null);
  let pdfPath: string | null = $state(null);
  let showingNotes = $state(false);
  let placingNote = $state(false);
  let showingSidebar = $state(true);
  let fullscreen = $state(false);
  let pdfIcon = $state("");
  let reader: Reader | undefined = $state();

  let promptDialog: HTMLDialogElement;
  let prompt = $state({ title: "", confirm: "", value: "" });
  let alertDialog: HTMLDialogElement;
  let alertMessage = $state("");

  // Leaves room for the traffic lights outside fullscreen.
  const windowed = $derived(api.platform === "darwin" && !fullscreen);
  /** Slides the list open while the files travel down from the folder, and back up on close. */
  function reveal(node: Element) {
    const { css } = slide(node, { duration: 200 });
    return {
      duration: 200,
      easing: cubicOut,
      css: (t: number, u: number) => `${css?.(t, u)}; transform: translateY(${-u * 12}px); opacity: ${t}`,
    };
  }

  const baseName = (name: string) => name.replace(/\.pdf$/i, "");

  onMount(async () => {
    pdfIcon = await api.icon();
    await perform(reload);
  });

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
      toggleNotes: () => (showingNotes = !showingNotes),
      zoomIn: () => reader?.zoomIn(),
      zoomOut: () => reader?.zoomOut(),
      zoomReset: () => reader?.zoom(1),
      zoomFit: () => reader?.zoom(null),
      undo: () => reader?.undo(),
      redo: () => reader?.redo(),
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
      openPDF(imported);
    });
  }

  function openPDF(path: string) {
    const parent = folders.find((f) => f.pdfs.some((p) => p.path === path));
    folderPath = parent?.path ?? null;
    if (parent) expanded.add(parent.path);
    pdfPath = path;
  }

  async function pdfMenu(pdf: PDF) {
    const choice = await api.contextMenu([
      { id: "rename", label: "Rename…" },
      { id: "trash", label: "Move to Trash" },
    ]);
    if (choice === "rename") {
      const name = await ask("Rename PDF", "Rename", baseName(pdf.name));
      if (name == null) return;
      await perform(async () => {
        const renamed = await api.renamePDF(pdf.path, name);
        if (pdfPath === pdf.path) pdfPath = renamed;
        await reload();
      });
    } else if (choice === "trash") {
      await perform(async () => {
        await api.trashPDF(pdf.path);
        if (pdfPath === pdf.path) pdfPath = null;
        await reload();
      });
    }
  }

  async function folderMenu(target: Folder) {
    const choice = await api.contextMenu([{ id: "import", label: "Import PDF…" }]);
    if (choice === "import") {
      folderPath = target.path;
      await importInto(target.path);
    }
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
    <div id="reader-controls" class:windowed class:floating={!showingSidebar}>
      {@render iconButton("newFolder", "New Folder", newFolder)}
      {@render iconButton("add", "Import PDF", () => importInto(folderPath), !folderPath)}
    </div>
    <div id="sidebar-toggle" class:floating={!showingSidebar}>
      {@render iconButton("sidebar", showingSidebar ? "Hide Sidebar" : "Show Sidebar", () => (showingSidebar = !showingSidebar))}
    </div>
    {#if showingSidebar}
      <aside
        id="sidebar"
        transition:slide={{ axis: "x", duration: 200 }}
      >
        {#if folders.length === 0}
          <EmptyState icon="newFolder" title="Create a folder" action={{ label: "New Folder", run: newFolder }} />
        {:else}
          <ul role="tree">
            {#each folders as f (f.path)}
              {@const open = expanded.has(f.path)}
              <li role="treeitem" aria-expanded={open} aria-selected={folderPath === f.path && !pdfPath}>
                <button
                  class="row"
                  class:selected={folderPath === f.path && !pdfPath}
                  onclick={() => toggleFolder(f)}
                  oncontextmenu={() => folderMenu(f)}
                >
                  <span class="chevron" class:open><Icon name="chevronRight" size={12} /></span>
                  <span class="label">{f.name}</span>
                </button>
                {#if open}
                  <ul role="group" transition:reveal>
                    {#each f.pdfs as pdf (pdf.path)}
                      <li role="treeitem" aria-selected={pdfPath === pdf.path}>
                        <button
                          class="row pdf"
                          class:selected={pdfPath === pdf.path}
                          onclick={() => openPDF(pdf.path)}
                          oncontextmenu={() => pdfMenu(pdf)}
                        >
                          <img src={pdfIcon} alt="" />
                          <span class="label">{pdf.name}</span>
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
    {/if}
    <div id="document">
      <Reader
        bind:this={reader}
        path={pdfPath}
        {showingNotes}
        bind:placingNote
        inset={showingSidebar ? SIDEBAR_INSET : 0}
        onerror={showError}
      />
      {#if pdfPath}
        <div id="bottom-toolbar" class="floating" style:--inset="{showingSidebar ? SIDEBAR_INSET : 0}px">
          {@render iconButton("notes", "Notes", () => (showingNotes = !showingNotes), false, showingNotes)}
          {@render iconButton("pageNote", "Add Note to Page", () => (placingNote = !placingNote), false, placingNote)}
          {@render iconButton("photo", "Add Image to Page", () => reader?.insertImage())}
        </div>
      {/if}
    </div>
  </section>
</main>

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
