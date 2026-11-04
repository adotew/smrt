<script>
  import { onDestroy, untrack } from "svelte";
  import EmptyState from "./EmptyState.svelte";
  import { openPDF, pdfjs } from "./pdf.js";

  const api = window.smrt;
  const NOTES_WIDTH = 280;
  const PAGE_GAP = 12;

  let { path, showingNotes, resizing = false, onerror } = $props();

  let doc = null;
  /** Each page's size at scale 1. */
  let pages = $state.raw([]);
  /** Null means the pages are scaled to fit. */
  let scale = $state(null);
  /** Null while no notes are loaded, so a file that failed to load is never overwritten. */
  let notes = $state(null);
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
      notes = await api.readNotes(pdf);
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

  function editNote(page, text) {
    notes[page] = text;
    api.saveNotes(path, $state.snapshot(notes)).catch(onerror);
  }
</script>

<div
  id="pages"
  bind:this={container}
  bind:clientWidth={containerWidth}
  {onscroll}
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
        style:width="{page.width * effective}px"
        style:height="{page.height * effective}px"
        {@attach (element) => observe(element, index)}
      ></div>
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
