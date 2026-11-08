<script lang="ts">
  import { onDestroy, tick, untrack } from "svelte";
  import type { PageViewport, PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";
  import type { Annotations, Notes, PageEdit, PageImage, PageNote, Rect, Versions } from "../electron/library.ts";
  import type { MenuItem } from "../electron/main.ts";
  import { cubicOut } from "svelte/easing";
  import { scale as grow } from "svelte/transition";
  import Icon from "./Icon.svelte";
  import { pickImage, shrinkImage } from "./image.ts";
  import { openPDF, pdfjs } from "./pdf.ts";

  interface Sheet {
    pdfPage: PDFPageProxy;
    element: HTMLElement | null;
    drawnScale: number;
    visible: boolean;
    task: RenderTask | null;
  }
  /** An undo step; `key` and `at` merge rapid edits, and `pdf` marks a page edit. */
  interface Step {
    notes: Notes;
    annotations: Annotations;
    key?: string;
    at?: number;
    pdf?: Versions;
  }
  type Target<E extends Event, T extends Element = HTMLElement> = E & { currentTarget: T };

  const api = window.smrt;
  const NOTES_WIDTH = 280;
  const PAGE_GAP = 12;
  /** A note's default text box size at scale 1. */
  const NOTE_SIZE = [180, 90] as const;
  const TEXT_SIZES = [10, 12, 14, 18, 24, 32, 48];
  const TEXT_STYLES = [
    ["bold", "Bold"],
    ["italic", "Italic"],
    ["underline", "Underline"],
  ] as const;
  const COLORS = ["yellow", "orange", "red", "pink", "purple", "blue", "green"];

  let {
    path,
    showingNotes,
    placingNote = $bindable(false),
    editingText = $bindable(false),
    inset = 0,
    onerror,
  }: {
    path: string | null;
    showingNotes: boolean;
    placingNote?: boolean;
    /** Whether a text box is being edited, so its formatting bar replaces the PDF toolbar. */
    editingText?: boolean;
    /** Width on the left covered by the floating sidebar; pages are laid out beside it. */
    inset?: number;
    onerror: (error: unknown) => void;
  } = $props();

  let doc: PDFDocumentProxy | null = null;
  /** Each page's size at scale 1. */
  let pages: PageViewport[] = $state.raw([]);
  /** Null means the pages are scaled to fit. */
  let scale: number | null = $state(null);
  /** Null while no notes are loaded, so a file that failed to load is never overwritten. */
  let notes: Notes | null = $state(null);
  /** Null while not loaded, like notes. */
  let annotations: Annotations | null = $state(null);
  /** Where the colour picker shows for the current text selection. */
  let picker: { x: number; y: number } | null = $state(null);
  /** The page note whose text is being edited; the others are dragged instead. */
  let editingNote: string | null = $state(null);
  /** The image picked by a double-click, which shows its resize handle and can be deleted. */
  let selectedImage: string | null = $state(null);
  /** See `record`. */
  let undoStack: Step[] = [];
  let redoStack: Step[] = [];
  let containerWidth = $state(0);
  let container: HTMLElement;
  let rows: HTMLElement[] = [];
  let sheets: Sheet[] = [];
  let currentPage = 0;
  let anchor: { page: number; offset: number } | null = null;

  const withNotes = $derived(showingNotes && notes != null);
  const editedNote = $derived.by(() => annotations?.pageNotes?.find((n) => n.id === editingNote));
  $effect(() => {
    editingText = editedNote != null;
  });
  const fit = $derived(
    pages.length === 0
      ? 1
      : Math.max(
          0.1,
          (containerWidth - inset - (withNotes ? NOTES_WIDTH + PAGE_GAP : 0) - PAGE_GAP * 2) / Math.max(...pages.map((p) => p.width)),
        ),
  );
  const effective = $derived(scale ?? fit);

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const sheet = sheets[Number((entry.target as HTMLElement).dataset.index)];
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
    return () => {
      close(pdf);
      undoStack = [];
      redoStack = [];
    };
  });

  async function load(pdf: string) {
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

  function close(pdf: string) {
    saveTyped.flush(pdf);
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
    editingNote = null;
    selectedImage = null;
    scale = null;
  }

  onDestroy(() => observer.disconnect());

  // Keep the current page and offset in view while the page size changes.
  // Reading `effective` subscribes the effects to it; everything else is read untracked.
  $effect.pre(() => {
    void effective;
    untrack(captureAnchor);
  });
  $effect(() => {
    void effective;
    untrack(restoreAnchor);
  });

  function captureAnchor() {
    const row = rows[currentPage];
    if (row && !anchor) anchor = { page: currentPage, offset: (container.scrollTop - row.offsetTop) / row.offsetHeight };
  }

  function restoreAnchor() {
    const row = anchor && rows[anchor.page];
    if (!anchor || !row) return;
    container.scrollTop = row.offsetTop + anchor.offset * row.offsetHeight;
    anchor = null;
    scheduleRedraw();
  }

  let redrawTimer: ReturnType<typeof setTimeout> | undefined;
  function scheduleRedraw() {
    clearTimeout(redrawTimer);
    // Pinching fires continuously, and the sidebar slides for 0.2s; the stretched old canvas stands in until both settle.
    redrawTimer = setTimeout(() => sheets.filter((s) => s.visible).forEach(draw), 250);
  }

  async function draw(sheet: Sheet) {
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
      canvasContext: canvas.getContext("2d")!,
      viewport,
      transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
    });
    try {
      await sheet.task.promise;
    } catch (error) {
      if (error instanceof pdfjs.RenderingCancelledException) return;
      throw error;
    }
    const textLayer = document.createElement("div");
    textLayer.className = "textLayer";
    sheet.element.style.setProperty("--total-scale-factor", String(scale));
    sheet.element.replaceChildren(canvas, textLayer);
    await new pdfjs.TextLayer({ textContentSource: sheet.pdfPage.streamTextContent(), container: textLayer, viewport })
      .render()
      .catch(() => {});
  }

  function observe(element: HTMLElement, index: number) {
    sheets[index].element = element;
    element.dataset.index = String(index);
    observer.observe(element);
    return () => observer.unobserve(element);
  }

  function debounce(fn: (pdf: string) => void, ms: number) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending: string | null = null;
    const flush = (pdf: string) => {
      clearTimeout(timer);
      if (pending !== pdf) return;
      pending = null;
      fn(pdf);
    };
    const debounced = (pdf: string) => {
      clearTimeout(timer);
      pending = pdf;
      timer = setTimeout(() => flush(pdf), ms);
    };
    return Object.assign(debounced, { flush });
  }

  // Saving rewrites every image in the file, so typing is saved once it pauses.
  const saveTyped = debounce((pdf: string) => {
    if (annotations) api.saveAnnotations(pdf, $state.snapshot(annotations)).catch(onerror);
  }, 300);

  const savePosition = debounce((pdf: string) => {
    // Losing a reading position is harmless, so failures are ignored.
    api.savePosition(pdf, { page: currentPage, scale: scale ?? undefined }).catch(() => {});
  }, 400);

  function onscroll() {
    picker = null;
    const top = container.scrollTop + 1;
    const index = rows.findIndex((row) => row && row.offsetTop + row.offsetHeight > top);
    if (index >= 0 && index !== currentPage) {
      currentPage = index;
      if (path) savePosition(path);
    }
  }

  // Trackpad pinches arrive as ctrl+wheel events.
  function onwheel(event: WheelEvent) {
    if (!event.ctrlKey) return;
    event.preventDefault();
    zoom(effective * Math.exp(-event.deltaY * 0.01));
  }

  export function zoom(next: number | null) {
    if (!doc || !path) return;
    scale = next == null ? null : Math.min(8, Math.max(0.1, next));
    savePosition(path);
  }

  export const zoomIn = () => zoom(effective * 1.25);
  export const zoomOut = () => zoom(effective / 1.25);

  /** The selected text's line boxes on each page, as page fractions. */
  function selectedRects() {
    const selection = getSelection();
    if (!annotations || !selection?.rangeCount || selection.isCollapsed) return [];
    const range = selection.getRangeAt(0);
    const root = range.commonAncestorContainer;
    const nodes: Node[] = [];
    if (root.nodeType === Node.TEXT_NODE) nodes.push(root);
    else {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) if (range.intersectsNode(walker.currentNode)) nodes.push(walker.currentNode);
    }
    const found: { page: number; client: DOMRect; rect: Rect }[] = [];
    for (const node of nodes) {
      const sheet = node.parentElement?.closest(".textLayer")?.closest<HTMLElement>(".sheet");
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
    picker = first ? { x: first.left, y: first.top < 60 ? first.bottom + 8 : first.top - 48 } : null;
  }

  // pdf.js splits lines into overlapping spans; joining them stops the overlaps from darkening.
  function mergeLines(rects: Rect[]) {
    const lines: Rect[] = [];
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
    return lines.map((line) => line.map((v) => Math.round(v * 1e4) / 1e4) as Rect);
  }

  // Only called once a PDF has loaded, so the fallbacks never apply.
  const current = (): Step => ({
    notes: $state.snapshot(notes) ?? {},
    annotations: $state.snapshot(annotations) ?? { highlights: [] },
  });

  /**
   * Remembers the notes and annotations before a change. Changes with the same `key` less than
   * a second apart, like typing, merge into one step.
   */
  function record(key?: string) {
    const top = undoStack.at(-1);
    const at = Date.now();
    redoStack = [];
    if (key && top?.key === key && at - (top.at ?? 0) < 1000) top.at = at;
    else undoStack.push({ ...current(), key, at });
  }

  export const undo = () => step(undoStack, redoStack, "before");
  export const redo = () => step(redoStack, undoStack, "after");

  // A PDF step holds both versions: undo restores `before`, redo restores `after`.
  async function step(from: Step[], to: Step[], version: keyof Versions) {
    const state = from.at(-1);
    if (editingPages || !state || !annotations || !path) return;
    const versions = state.pdf;
    if (!versions) {
      from.pop();
      to.push(current());
      notes = state.notes;
      annotations = state.annotations;
      editingNote = null;
      api.saveNotes(path, state.notes).catch(onerror);
      saveAnnotations();
      return;
    }
    // Nothing changes until the file is restored; the reload then shows what's on disk.
    const back = { ...current(), pdf: versions };
    await changePDF(async (pdf) => {
      await api.restoreVersion(pdf, versions[version]);
      await Promise.all([api.saveNotes(pdf, state.notes), api.saveAnnotations(pdf, state.annotations)]);
      from.pop();
      to.push(back);
    });
  }

  function highlight(color: string) {
    if (!annotations) return;
    record();
    for (const [page, found] of Map.groupBy(selectedRects(), (f) => f.page)) {
      annotations.highlights.push({ id: crypto.randomUUID(), page, color, rects: mergeLines(found.map((f) => f.rect)) });
    }
    getSelection()?.removeAllRanges();
    picker = null;
    saveAnnotations();
  }

  const PAGE_EDITS: Record<string, (page: number) => PageEdit> = {
    insertBlank: (page) => ({ action: "insertBlank", page }),
    duplicate: (page) => ({ action: "duplicate", page }),
    rotateLeft: (page) => ({ action: "rotate", page, rotate: -90 }),
    rotateRight: (page) => ({ action: "rotate", page, rotate: 90 }),
    delete: (page) => ({ action: "delete", page }),
  };

  // Highlights ignore the pointer so text stays selectable; right-clicks are hit-tested instead.
  async function pageMenu(event: Target<MouseEvent>, page: number) {
    const box = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - box.left) / box.width;
    const y = (event.clientY - box.top) / box.height;
    const hit = annotations?.highlights.findLast(
      (h) => h.page === page && h.rects.some(([rx, ry, rw, rh]) => x >= rx && x <= rx + rw && y >= ry && y <= ry + rh),
    );
    const image = (event.target as Element).closest<HTMLElement>(".page-image")?.dataset.id;
    const separator: MenuItem = { type: "separator" };
    const removeHighlight: MenuItem[] = hit ? [{ id: "removeHighlight", label: "Remove Highlight" }, separator] : [];
    const deletePage: MenuItem[] = pages.length > 1 ? [separator, { id: "delete", label: "Delete Page" }] : [];
    const imageItems: MenuItem[] = image ? [{ id: "removeImage", label: "Remove Image" }, separator] : [];
    const chosen = await api.contextMenu([
      ...imageItems,
      ...removeHighlight,
      { id: "insertBlank", label: "Insert Blank Page After" },
      { id: "duplicate", label: "Duplicate Page" },
      separator,
      { id: "rotateLeft", label: "Rotate Left" },
      { id: "rotateRight", label: "Rotate Right" },
      ...deletePage,
    ]);
    if (chosen === "removeHighlight" && annotations && hit) {
      record();
      annotations.highlights = annotations.highlights.filter((h) => h.id !== hit.id);
      saveAnnotations();
    } else if (chosen === "removeImage" && image) {
      removeImage(image);
    } else if (chosen && PAGE_EDITS[chosen]) {
      editPage(PAGE_EDITS[chosen](page));
    }
  }

  function editPage(edit: PageEdit) {
    const before = current();
    return changePDF(async (pdf) => {
      const versions = await api.editPage(pdf, edit);
      undoStack.push({ ...before, pdf: versions });
      redoStack = [];
    });
  }

  /** Runs `change` on the file, then reloads it. */
  let editingPages = false;
  async function changePDF(change: (pdf: string) => Promise<void>) {
    const pdf = path;
    if (!pdf || editingPages) return;
    editingPages = true;
    try {
      // The library moves the saved position along with the pages, so it must be current first.
      saveTyped.flush(pdf);
      savePosition.flush(pdf);
      await api.savePosition(pdf, { page: currentPage, scale: scale ?? undefined });
      await change(pdf);
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

  function placeNote(event: Target<MouseEvent>, page: number) {
    if (!placingNote || !annotations || (event.target as Element).closest(".page-note, .page-image")) return;
    const box = event.currentTarget.getBoundingClientRect();
    const id = crypto.randomUUID();
    record(id);
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

  async function editNoteText(id: string) {
    editingNote = id;
    // Wait for the textarea to become editable.
    await tick();
    document.getElementById(id)?.focus();
  }

  function editPageNote(note: PageNote, text: string) {
    if (!path) return;
    record(note.id);
    note.text = text;
    saveTyped(path);
  }

  // Sizes are kept at scale 1 so they scale with the page.
  function resizeNote(note: PageNote, textarea: HTMLTextAreaElement) {
    const w = Math.round(textarea.offsetWidth / effective);
    const h = Math.round(textarea.offsetHeight / effective);
    if (w === (note.w ?? NOTE_SIZE[0]) && h === (note.h ?? NOTE_SIZE[1])) return;
    record();
    Object.assign(note, { w, h });
    saveAnnotations();
  }

  function toggleTextStyle(note: PageNote, style: (typeof TEXT_STYLES)[number][0]) {
    record();
    note[style] = !note[style];
    saveAnnotations();
  }

  function resizeText(note: PageNote, step: 1 | -1) {
    const size = note.size ?? 14;
    const next = step > 0 ? TEXT_SIZES.find((s) => s > size) : TEXT_SIZES.findLast((s) => s < size);
    if (!next) return;
    record();
    note.size = next;
    saveAnnotations();
  }

  /** Runs `move` until the pointer is released; the whole gesture is one undo step, saved once. */
  function followPointer(move: (e: PointerEvent) => void) {
    let moved = false;
    const onmove = (e: PointerEvent) => {
      if (!moved) record();
      moved = true;
      move(e);
    };
    const stop = () => {
      removeEventListener("pointermove", onmove);
      removeEventListener("pointerup", stop);
      if (moved) saveAnnotations();
    };
    addEventListener("pointermove", onmove);
    addEventListener("pointerup", stop);
  }

  function dragNote(event: Target<PointerEvent>, note: PageNote | PageImage) {
    if (event.target instanceof HTMLTextAreaElement || !event.currentTarget.parentElement) return;
    event.preventDefault();
    const box = event.currentTarget.parentElement.getBoundingClientRect();
    const start = { x: event.clientX, y: event.clientY, noteX: note.x, noteY: note.y };
    const clamp = (v: number) => Math.min(1, Math.max(0, v));
    followPointer((e) => {
      note.x = clamp(start.noteX + (e.clientX - start.x) / box.width);
      note.y = clamp(start.noteY + (e.clientY - start.y) / box.height);
    });
  }

  // Keeps the image's proportions; sizes are at scale 1, like notes.
  function resizeImage(event: PointerEvent, image: PageImage) {
    event.stopPropagation();
    event.preventDefault();
    const start = { x: event.clientX, w: image.w, ratio: image.h / image.w };
    followPointer((e) => {
      image.w = Math.max(16, Math.round(start.w + (e.clientX - start.x) / effective));
      image.h = Math.round(image.w * start.ratio);
    });
  }

  function removeImage(id: string) {
    if (!annotations) return;
    record();
    annotations.pageImages = annotations.pageImages?.filter((i) => i.id !== id);
    if (selectedImage === id) selectedImage = null;
    saveAnnotations();
  }

  function onpointerdown(event: PointerEvent) {
    if (!(event.target as Element).closest(".page-image.selected")) selectedImage = null;
  }

  function onkeydown(event: KeyboardEvent) {
    if (!selectedImage) return;
    if (event.key === "Escape") selectedImage = null;
    else if ((event.key === "Backspace" || event.key === "Delete") && !(event.target as Element).closest("input, textarea")) {
      event.preventDefault();
      removeImage(selectedImage);
    }
  }

  /** Asks for an image and places it in the middle of the visible part of the current page. */
  export async function insertImage() {
    const file = await pickImage();
    if (!file || !annotations) return;
    let src: string, width: number, height: number;
    try {
      ({ src, width, height } = await shrinkImage(file));
    } catch {
      return onerror(new Error("This image could not be opened."));
    }
    const page = currentPage + 1;
    const size = pages[currentPage];
    const sheet = rows[currentPage]?.querySelector(".sheet");
    if (!annotations || !size || !sheet) return;
    const w = Math.min(width, size.width / 2, ((size.height / 2) * width) / height);
    const h = Math.round((w * height) / width);
    const box = sheet.getBoundingClientRect();
    const view = container.getBoundingClientRect();
    const middle = (view.top + view.height / 2 - box.top) / box.height;
    record();
    annotations.pageImages ??= [];
    annotations.pageImages.push({
      id: crypto.randomUUID(),
      page,
      x: 0.5 - w / size.width / 2,
      y: Math.min(1, Math.max(0, middle - h / size.height / 2)),
      w: Math.round(w),
      h,
      src,
    });
    saveAnnotations();
  }

  // A note left empty is discarded, so a stray click leaves nothing behind.
  function dropEmptyNote(note: PageNote) {
    if (path) saveTyped.flush(path);
    if (editingNote === note.id) editingNote = null;
    if (note.text || !annotations) return;
    // A note placed and left empty never happened, so its step goes too.
    const top = undoStack.at(-1);
    if (top?.key === note.id && !top.annotations.pageNotes?.some((n) => n.id === note.id)) undoStack.pop();
    else record();
    annotations.pageNotes = annotations.pageNotes?.filter((n) => n.id !== note.id);
    saveAnnotations();
  }

  function saveAnnotations() {
    if (!path || !annotations) return;
    api.saveAnnotations(path, $state.snapshot(annotations)).catch(onerror);
  }

  function editNote(page: number, text: string) {
    if (!path || !notes) return;
    record(`note ${page}`);
    notes[page] = text;
    api.saveNotes(path, $state.snapshot(notes)).catch(onerror);
  }
</script>

<svelte:window {onkeydown} onbeforeunload={() => path && saveTyped.flush(path)} />

<div
  class="pages"
  class:placing={placingNote}
  role="document"
  bind:this={container}
  bind:clientWidth={containerWidth}
  style:padding-left="{inset}px"
  {onscroll}
  {onpointerdown}
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
        {#each annotations?.pageImages ?? [] as image (image.id)}
          {#if image.page === index + 1}
            <div
              class="page-image"
              role="img"
              aria-label="Image on page {index + 1}"
              data-id={image.id}
              class:selected={selectedImage === image.id}
              style:left="min({image.x * 100}%, calc(100% - {image.w * effective}px))"
              style:top="min({image.y * 100}%, calc(100% - {image.h * effective}px))"
              style:width="{image.w * effective}px"
              style:height="{image.h * effective}px"
              onpointerdown={(event) => selectedImage === image.id && dragNote(event, image)}
              ondblclick={() => (selectedImage = image.id)}
            >
              <img src={image.src} alt="" draggable="false" />
              {#if selectedImage === image.id}
                <div class="resize-handle" role="presentation" onpointerdown={(event) => resizeImage(event, image)}></div>
              {/if}
            </div>
          {/if}
        {/each}
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
                style:--note-size={note.size && `${note.size}px`}
                style:font-weight={note.bold ? "bold" : null}
                style:font-style={note.italic ? "italic" : null}
                style:text-decoration={note.underline ? "underline" : null}
                readonly={editingNote !== note.id}
                onmouseup={(event) => resizeNote(note, event.currentTarget)}
                oninput={(event) => editPageNote(note, event.currentTarget.value)}
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
            value={notes?.[index + 1] ?? ""}
            oninput={(event) => editNote(index + 1, event.currentTarget.value)}
          ></textarea>
        </label>
      {/if}
    </div>
  {:else}
    {#if !path}
      <div class="empty">
        <div class="brand">Smrt</div>
      </div>
    {/if}
  {/each}
</div>

<!-- Preventing mousedown keeps the note focused, so it stays in editing. -->
{#if editedNote}
  {@const note = editedNote}
  <div
    class="bottom-toolbar text-format floating"
    role="toolbar"
    tabindex="-1"
    style:--inset="{inset}px"
    transition:grow={{ start: 0.9, duration: 180, easing: cubicOut }}
    onmousedown={(event) => event.preventDefault()}
  >
    {#each TEXT_STYLES as [style, label] (style)}
      <button
        class="icon-button"
        class:active={note[style]}
        title={label}
        aria-label={label}
        aria-pressed={!!note[style]}
        onclick={() => toggleTextStyle(note, style)}
      >
        <Icon name={style} />
      </button>
    {/each}
    <div class="toolbar-separator"></div>
    <button
      class="icon-button"
      title="Smaller Text"
      aria-label="Smaller Text"
      aria-disabled={(note.size ?? 14) <= TEXT_SIZES[0]}
      onclick={() => resizeText(note, -1)}
    >
      <Icon name="minus" />
    </button>
    <span class="text-size">{note.size ?? 14}</span>
    <button
      class="icon-button"
      title="Larger Text"
      aria-label="Larger Text"
      aria-disabled={(note.size ?? 14) >= TEXT_SIZES.at(-1)!}
      onclick={() => resizeText(note, 1)}
    >
      <Icon name="add" />
    </button>
  </div>
{/if}

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
