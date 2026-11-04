<script>
  import { onDestroy, tick, untrack } from "svelte";
  import EmptyState from "./EmptyState.svelte";
  import { openPDF, pdfjs } from "./pdf.js";

  const api = window.smrt;
  const NOTES_WIDTH = 280;
  const PAGE_GAP = 12;
  /** A note's default text box size at scale 1. */
  const NOTE_SIZE = [180, 90];
  const COLORS = ["yellow", "green", "blue", "pink"];

  let { path, showingNotes, placingNote = $bindable(false), resizing = false, onerror } = $props();

  let doc = null;
  /** Each page's size at scale 1. */
  let pages = $state.raw([]);
  /** Null means the pages are scaled to fit. */
  let scale = $state(null);
  /** Null while no notes are loaded, so a file that failed to load is never overwritten. */
  let notes = $state(null);
  /** Null while not loaded, like notes. */
  let annotations = $state(null);
  /** Where the colour picker shows for the current text selection. */
  let picker = $state(null);
  /** The page note whose text is being edited; the others are dragged instead. */
  let editingNote = $state(null);
  let containerWidth = $state(0);
  /** Holds still while the sidebar animates, so pages are laid out once at the end instead of every frame. */
  let fitWidth = $state(0);
  let container;
  let rows = [];
  let sheets = [];
  let currentPage = 0;
  let anchor = null;

  const withNotes = $derived(showingNotes && notes != null);
  const fit = $derived(
    pages.length === 0
      ? 1
      : Math.max(
          0.1,
          (fitWidth - (withNotes ? NOTES_WIDTH + PAGE_GAP : 0) - PAGE_GAP * 2) / Math.max(...pages.map((p) => p.width)),
        ),
  );
  const effective = $derived(scale ?? fit);

  $effect(() => {
    if (!resizing) fitWidth = containerWidth;
  });

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const sheet = sheets[Number(entry.target.dataset.index)];
        sheet.visible = entry.isIntersecting;
        if (sheet.visible) draw(sheet);
      }
    },
    { rootMargin: "100% 0px" },
  );

  $effect(() => {
    const pdf = path;
    if (!pdf) return;
    untrack(() => load(pdf));
    return () => close(pdf);
  });

  async function load(pdf) {
    try {
      let opened;
      try {
        opened = await openPDF(await api.readPDF(pdf));
      } catch {
        throw new Error("This file could not be opened as a PDF.");
      }
      if (pdf !== path) return opened.loadingTask.destroy();
      const [pdfPages, position] = await Promise.all([
        Promise.all(Array.from({ length: opened.numPages }, (_, i) => opened.getPage(i + 1))),
        api.readPosition(pdf),
      ]);
      doc = opened;
      sheets = pdfPages.map((pdfPage) => ({ pdfPage, element: null, drawnScale: 0, visible: false, task: null }));
      scale = position?.scale ?? null;
      currentPage = Math.min(position?.page ?? 0, pdfPages.length - 1);
      anchor = { page: currentPage, offset: 0 };
      pages = pdfPages.map((page) => page.getViewport({ scale: 1 }));
      [notes, annotations] = await Promise.all([api.readNotes(pdf), api.readAnnotations(pdf)]);
    } catch (error) {
      onerror(error);
    }
  }

  function close(pdf) {
    savePosition.flush(pdf);
    observer.disconnect();
    for (const sheet of sheets) sheet.task?.cancel();
    doc?.loadingTask.destroy();
    doc = null;
    sheets = [];
    rows = [];
    pages = [];
    notes = null;
    annotations = null;
    picker = null;
    scale = null;
  }

  onDestroy(() => observer.disconnect());

  // Keep the current page and offset in view while the page size changes.
  // Passing `effective` subscribes the effects to it; everything else is read untracked.
  $effect.pre(() => untrack(captureAnchor, effective));
  $effect(() => untrack(restoreAnchor, effective));

  function captureAnchor() {
    const row = rows[currentPage];
    if (row && !anchor) anchor = { page: currentPage, offset: (container.scrollTop - row.offsetTop) / row.offsetHeight };
  }

  function restoreAnchor() {
    const row = anchor && rows[anchor.page];
    if (!row) return;
    container.scrollTop = row.offsetTop + anchor.offset * row.offsetHeight;
    anchor = null;
    scheduleRedraw();
  }

  let redrawTimer;
  function scheduleRedraw() {
    clearTimeout(redrawTimer);
    // Pinching fires continuously; the stretched old canvas stands in until it settles.
    redrawTimer = setTimeout(() => sheets.filter((s) => s.visible).forEach(draw), 120);
  }

  async function draw(sheet) {
    const scale = effective;
    if (sheet.drawnScale === scale || !sheet.element) return;
    sheet.drawnScale = scale;
    sheet.task?.cancel();
    const viewport = sheet.pdfPage.getViewport({ scale });
    const ratio = window.devicePixelRatio || 1;
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width * ratio);
    canvas.height = Math.floor(viewport.height * ratio);
    sheet.task = sheet.pdfPage.render({
      canvas,
      canvasContext: canvas.getContext("2d"),
      viewport,
      transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0],
    });
    try {
      await sheet.task.promise;
    } catch (error) {
      if (error instanceof pdfjs.RenderingCancelledException) return;
      throw error;
    }
    const textLayer = document.createElement("div");
    textLayer.className = "textLayer";
    sheet.element.style.setProperty("--total-scale-factor", scale);
    sheet.element.replaceChildren(canvas, textLayer);
    await new pdfjs.TextLayer({ textContentSource: sheet.pdfPage.streamTextContent(), container: textLayer, viewport })
      .render()
      .catch(() => {});
  }

  function observe(element, index) {
    sheets[index].element = element;
    element.dataset.index = index;
    observer.observe(element);
    return () => observer.unobserve(element);
  }

  function debounce(fn, ms) {
    let timer;
    let pending = null;
    const debounced = (pdf) => {
      clearTimeout(timer);
      pending = pdf;
      timer = setTimeout(() => debounced.flush(pdf), ms);
    };
    debounced.flush = (pdf) => {
      clearTimeout(timer);
      if (pending !== pdf) return;
      pending = null;
      fn(pdf);
    };
    return debounced;
  }

  const savePosition = debounce((pdf) => {
    // Losing a reading position is harmless, so failures are ignored.
    api.savePosition(pdf, { page: currentPage, scale: scale ?? undefined }).catch(() => {});
  }, 400);

  function onscroll() {
    picker = null;
    const top = container.scrollTop + 1;
    const index = rows.findIndex((row) => row && row.offsetTop + row.offsetHeight > top);
    if (index >= 0 && index !== currentPage) {
      currentPage = index;
      savePosition(path);
    }
  }

  // Trackpad pinches arrive as ctrl+wheel events.
  function onwheel(event) {
    if (!event.ctrlKey) return;
    event.preventDefault();
    zoom(effective * Math.exp(-event.deltaY * 0.01));
  }

  export function zoom(next) {
    if (!doc) return;
    scale = next == null ? null : Math.min(8, Math.max(0.1, next));
    savePosition(path);
  }

  export const zoomIn = () => zoom(effective * 1.25);
  export const zoomOut = () => zoom(effective / 1.25);

  /** The selected text's line boxes on each page, as page fractions. */
  function selectedRects() {
    const selection = getSelection();
    if (!annotations || !selection.rangeCount || selection.isCollapsed) return [];
    const range = selection.getRangeAt(0);
    const root = range.commonAncestorContainer;
    const nodes = [];
    if (root.nodeType === Node.TEXT_NODE) nodes.push(root);
    else {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) if (range.intersectsNode(walker.currentNode)) nodes.push(walker.currentNode);
    }
    const found = [];
    for (const node of nodes) {
      const sheet = node.parentElement.closest(".textLayer")?.closest(".sheet");
      if (!sheet) continue;
      // Measuring each text node skips the layer's own boxes, which span the whole page.
      const part = document.createRange();
      part.selectNodeContents(node);
      if (node === range.startContainer) part.setStart(node, range.startOffset);
      if (node === range.endContainer) part.setEnd(node, range.endOffset);
      const box = sheet.getBoundingClientRect();
      for (const rect of part.getClientRects()) {
        if (!rect.width || !rect.height) continue;
        found.push({
          page: Number(sheet.dataset.page),
          client: rect,
          rect: [
            (rect.left - box.left) / box.width,
            (rect.top - box.top) / box.height,
            rect.width / box.width,
            rect.height / box.height,
          ],
        });
      }
    }
    return found;
  }

  function onpointerup() {
    const first = selectedRects()[0]?.client;
    picker = first && { x: first.left, y: first.top < 60 ? first.bottom + 8 : first.top - 48 };
  }

  // pdf.js splits lines into overlapping spans; joining them stops the overlaps from darkening.
  function mergeLines(rects) {
    const lines = [];
    for (const [x, y, w, h] of rects.toSorted((a, b) => a[1] - b[1] || a[0] - b[0])) {
      const line = lines.find((l) => Math.abs(l[1] - y) < l[3] / 2 && x <= l[0] + l[2] + 0.01);
      if (!line) {
        lines.push([x, y, w, h]);
        continue;
      }
      const right = Math.max(line[0] + line[2], x + w);
      const bottom = Math.max(line[1] + line[3], y + h);
      line[0] = Math.min(line[0], x);
      line[1] = Math.min(line[1], y);
      line[2] = right - line[0];
      line[3] = bottom - line[1];
    }
    return lines.map((line) => line.map((v) => Math.round(v * 1e4) / 1e4));
  }

  function highlight(color) {
    for (const [page, found] of Map.groupBy(selectedRects(), (f) => f.page)) {
      annotations.highlights.push({ id: crypto.randomUUID(), page, color, rects: mergeLines(found.map((f) => f.rect)) });
    }
    getSelection().removeAllRanges();
    picker = null;
    saveAnnotations();
  }

  const PAGE_EDITS = {
    insertBlank: { action: "insertBlank" },
    duplicate: { action: "duplicate" },
    rotateLeft: { action: "rotate", rotate: -90 },
    rotateRight: { action: "rotate", rotate: 90 },
    delete: { action: "delete" },
  };

  // Highlights ignore the pointer so text stays selectable; right-clicks are hit-tested instead.
  async function pageMenu(event, page) {
    const box = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - box.left) / box.width;
    const y = (event.clientY - box.top) / box.height;
    const hit = annotations?.highlights.findLast(
      (h) => h.page === page && h.rects.some(([rx, ry, rw, rh]) => x >= rx && x <= rx + rw && y >= ry && y <= ry + rh),
    );
    const separator = { type: "separator" };
    const chosen = await api.contextMenu([
      ...(hit ? [{ id: "removeHighlight", label: "Remove Highlight" }, separator] : []),
      { id: "insertBlank", label: "Insert Blank Page After" },
      { id: "duplicate", label: "Duplicate Page" },
      separator,
      { id: "rotateLeft", label: "Rotate Left" },
      { id: "rotateRight", label: "Rotate Right" },
      ...(pages.length > 1 ? [separator, { id: "delete", label: "Delete Page" }] : []),
    ]);
    if (chosen === "removeHighlight") {
      annotations.highlights = annotations.highlights.filter((h) => h.id !== hit.id);
      saveAnnotations();
    } else if (PAGE_EDITS[chosen]) {
      editPage({ ...PAGE_EDITS[chosen], page });
    }
  }

  let editingPages = false;
  async function editPage(edit) {
    const pdf = path;
    if (editingPages) return;
    editingPages = true;
    try {
      // The library moves the saved position along with the pages, so it must be current first.
      savePosition.flush(pdf);
      await api.savePosition(pdf, { page: currentPage, scale: scale ?? undefined });
      await api.editPage(pdf, edit);
      if (pdf !== path) return;
      close(pdf);
      await load(pdf);
      // Reloading at an unchanged scale doesn't re-run the anchor effect.
      await tick();
      restoreAnchor();
    } catch (error) {
      onerror(error);
    } finally {
      editingPages = false;
    }
  }

  function placeNote(event, page) {
    if (!placingNote || event.target.closest(".page-note")) return;
    const box = event.currentTarget.getBoundingClientRect();
    const id = crypto.randomUUID();
    annotations.pageNotes ??= [];
    annotations.pageNotes.push({
      id,
      page,
      x: (event.clientX - box.left) / box.width,
      y: (event.clientY - box.top) / box.height,
      text: "",
    });
    placingNote = false;
    editNoteText(id);
  }

  async function editNoteText(id) {
    editingNote = id;
    // Wait for the textarea to become editable.
    await tick();
    document.getElementById(id)?.focus();
  }

  function editPageNote(note, text) {
    note.text = text;
    saveAnnotations();
  }

  // Sizes are kept at scale 1 so they scale with the page.
  function resizeNote(note, textarea) {
    const w = Math.round(textarea.offsetWidth / effective);
    const h = Math.round(textarea.offsetHeight / effective);
    if (w === (note.w ?? NOTE_SIZE[0]) && h === (note.h ?? NOTE_SIZE[1])) return;
    Object.assign(note, { w, h });
    saveAnnotations();
  }

  function dragNote(event, note) {
    if (event.target.tagName === "TEXTAREA") return;
    event.preventDefault();
    const box = event.currentTarget.parentElement.getBoundingClientRect();
    const start = { x: event.clientX, y: event.clientY, noteX: note.x, noteY: note.y };
    const clamp = (v) => Math.min(1, Math.max(0, v));
    const move = (e) => {
      note.x = clamp(start.noteX + (e.clientX - start.x) / box.width);
      note.y = clamp(start.noteY + (e.clientY - start.y) / box.height);
    };
    const stop = () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", stop);
      saveAnnotations();
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", stop);
  }

  // A note left empty is discarded, so a stray click leaves nothing behind.
  function dropEmptyNote(note) {
    if (editingNote === note.id) editingNote = null;
    if (note.text) return;
    annotations.pageNotes = annotations.pageNotes.filter((n) => n.id !== note.id);
    saveAnnotations();
  }

  function saveAnnotations() {
    api.saveAnnotations(path, $state.snapshot(annotations)).catch(onerror);
  }

  function editNote(page, text) {
    notes[page] = text;
    api.saveNotes(path, $state.snapshot(notes)).catch(onerror);
  }
</script>

<div
  id="pages"
  class:placing={placingNote}
  role="document"
  bind:this={container}
  bind:clientWidth={containerWidth}
  {onscroll}
  {onpointerup}
  {@attach (element) => {
    // Svelte registers wheel listeners as passive, which would ignore preventDefault.
    element.addEventListener("wheel", onwheel, { passive: false });
    return () => element.removeEventListener("wheel", onwheel);
  }}
>
  {#each pages as page, index (index)}
    <div class="page-row" bind:this={rows[index]}>
      <div
        class="sheet"
        role="group"
        aria-label="Page {index + 1}"
        data-page={index + 1}
        style:width="{page.width * effective}px"
        style:height="{page.height * effective}px"
        oncontextmenu={(event) => pageMenu(event, index + 1)}
        onclick={(event) => placeNote(event, index + 1)}
      >
        <div class="render" {@attach (element) => observe(element, index)}></div>
        {#each annotations?.pageNotes ?? [] as note (note.id)}
          {#if note.page === index + 1}
            <!-- Drag anywhere on the note; double-click to edit its text. -->
            <div
              class="page-note"
              role="group"
              aria-label="Note on page {index + 1}"
              style:--note-scale={effective}
              style:left="min({note.x * 100}%, calc(100% - {((note.w ?? NOTE_SIZE[0]) + 12) * effective}px))"
              style:top="min({note.y * 100}%, calc(100% - {((note.h ?? NOTE_SIZE[1]) + 12) * effective}px))"
              class:editing={editingNote === note.id}
              onpointerdown={(event) => dragNote(event, note)}
              ondblclick={() => editNoteText(note.id)}
            >
              <textarea
                id={note.id}
                aria-label="Note text"
                placeholder="Text"
                value={note.text}
                style:width="{(note.w ?? NOTE_SIZE[0]) * effective}px"
                style:height="{(note.h ?? NOTE_SIZE[1]) * effective}px"
                readonly={editingNote !== note.id}
                onmouseup={(event) => resizeNote(note, event.currentTarget)}
                oninput={(event) => editPageNote(note, event.target.value)}
                onblur={() => dropEmptyNote(note)}
              ></textarea>
            </div>
          {/if}
        {/each}
        {#each annotations?.highlights ?? [] as h (h.id)}
          {#if h.page === index + 1}
            {#each h.rects as [x, y, width, height], i (i)}
              <div
                class="highlight"
                data-color={h.color}
                style:left="{x * 100}%"
                style:top="{y * 100}%"
                style:width="{width * 100}%"
                style:height="{height * 100}%"
              ></div>
            {/each}
          {/if}
        {/each}
      </div>
      {#if withNotes}
        <label class="note">
          <textarea
            placeholder="Add a note…"
            aria-label="Note for page {index + 1}"
            value={notes[index + 1] ?? ""}
            oninput={(event) => editNote(index + 1, event.target.value)}
          ></textarea>
        </label>
      {/if}
    </div>
  {:else}
    {#if !path}<EmptyState icon="document" title="Select a PDF" />{/if}
  {/each}
</div>

{#if picker}
  <div class="highlight-picker floating" style:left="{picker.x}px" style:top="{picker.y}px">
    {#each COLORS as color (color)}
      <!-- Keeping focus where it is stops the click from clearing the selection. -->
      <button
        class="swatch"
        data-color={color}
        title="Highlight"
        aria-label="Highlight {color}"
        onmousedown={(event) => event.preventDefault()}
        onclick={() => highlight(color)}
      ></button>
    {/each}
  </div>
{/if}
