import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type Ref,
} from "react";
import { flushSync } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import type { PageViewport, PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";
import type { Annotations, Notes, PageEdit, PageImage, PageNote, Rect, Versions } from "../electron/library.ts";
import { contextMenu, type MenuItem } from "./ContextMenu.tsx";
import Icon from "./Icon.tsx";
import { pickImage, shrinkImage } from "./image.ts";
import { openPDF, pdfjs } from "./pdf.ts";
import { grow, slide } from "./transitions.ts";

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

export interface ReaderHandle {
  zoom: (next: number | null) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  undo: () => void;
  redo: () => void;
  insertImage: () => void;
}

const api = window.smrt;
const NOTES_WIDTH = 280;
const PAGE_GAP = 12;
/** A note's default text box size at scale 1. */
const NOTE_SIZE = [180, 90] as const;
const TEXT_SIZES = [8, 10, 12, 14, 18, 24, 32, 48];
const TEXT_STYLES = [
  ["bold", "Bold"],
  ["italic", "Italic"],
  ["underline", "Underline"],
] as const;
/** Dark enough to read on a white page. */
const TEXT_COLORS = [
  ["#000000", "Black"],
  ["#d70015", "Red"],
  ["#c93400", "Orange"],
  ["#248a3d", "Green"],
  ["#0040dd", "Blue"],
  ["#8944ab", "Purple"],
] as const;
const COLORS = ["yellow", "orange", "red", "pink", "purple", "blue", "green"];

const PAGE_EDITS: Record<string, (page: number) => PageEdit> = {
  insertBlank: (page) => ({ action: "insertBlank", page }),
  duplicate: (page) => ({ action: "duplicate", page }),
  rotateLeft: (page) => ({ action: "rotate", page, rotate: -90 }),
  rotateRight: (page) => ({ action: "rotate", page, rotate: 90 }),
  delete: (page) => ({ action: "delete", page }),
};

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

interface Props {
  ref?: Ref<ReaderHandle>;
  path: string | null;
  showingNotes: boolean;
  placingNote?: boolean;
  onPlacingNoteChange?: (placing: boolean) => void;
  /** Called with whether a text box is being edited, so its formatting bar replaces the PDF toolbar. */
  onEditingTextChange?: (editing: boolean) => void;
  /** Width on the left covered by the floating sidebar; pages are laid out beside it. */
  inset?: number;
  onerror: (error: unknown) => void;
}

export default function Reader(props: Props) {
  const { ref, path, showingNotes, placingNote = false, inset = 0 } = props;
  // Listeners and async loads outlive a render, so they read props through this.
  const latest = useRef(props);
  latest.current = props;
  const onerror = (error: unknown) => latest.current.onerror(error);
  const [, update] = useReducer((n: number) => n + 1, 0);
  const container = useRef<HTMLDivElement>(null);
  /** Changed in place by loads, drags and typing, many times a second; `update()` shows the changes. */
  const [s] = useState(() => ({
    doc: null as PDFDocumentProxy | null,
    /** Each page's size at scale 1. */
    pages: [] as PageViewport[],
    /** Null means the pages are scaled to fit. */
    scale: null as number | null,
    /** Null while no notes are loaded, so a file that failed to load is never overwritten. */
    notes: null as Notes | null,
    /** Null while not loaded, like notes. */
    annotations: null as Annotations | null,
    /** Where the colour picker shows for the current text selection. */
    picker: null as { x: number; y: number } | null,
    /** The page note whose text is being edited; the others are dragged instead. */
    editingNote: null as string | null,
    /** The image picked by a double-click, which shows its resize handle and can be deleted. */
    selectedImage: null as string | null,
    /** Whether the formatting bar shows every text colour instead of just the current one. */
    pickingColor: false,
    /** See `record`. */
    undoStack: [] as Step[],
    redoStack: [] as Step[],
    containerWidth: 0,
    rows: [] as (HTMLElement | null)[],
    sheets: [] as Sheet[],
    currentPage: 0,
    anchor: null as { page: number; offset: number } | null,
    /** The scale the pages were last laid out at. */
    laidOut: 0,
    editingPages: false,
  }));

  const withNotes = () => latest.current.showingNotes && s.notes != null;
  const fit = () =>
    s.pages.length === 0
      ? 1
      : Math.max(
          0.1,
          (s.containerWidth - (latest.current.inset ?? 0) - (withNotes() ? NOTES_WIDTH + PAGE_GAP : 0) - PAGE_GAP * 2) /
            Math.max(...s.pages.map((page) => page.width)),
        );
  const effective = () => s.scale ?? fit();

  const [observer] = useState(
    () =>
      new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            const sheet = s.sheets[Number((entry.target as HTMLElement).dataset.index)];
            if (!sheet) continue;
            sheet.visible = entry.isIntersecting;
            if (sheet.visible) draw(sheet);
          }
        },
        { rootMargin: "100% 0px" },
      ),
  );

  // Saving rewrites every image in the file, so typing is saved once it pauses.
  const [saveTyped] = useState(() =>
    debounce((pdf: string) => {
      if (s.annotations) api.saveAnnotations(pdf, s.annotations).catch(onerror);
    }, 300),
  );

  const [savePosition] = useState(() =>
    debounce((pdf: string) => {
      // Losing a reading position is harmless, so failures are ignored.
      api.savePosition(pdf, { page: s.currentPage, scale: s.scale ?? undefined }).catch(() => {});
    }, 400),
  );

  useEffect(() => {
    if (!path) return;
    load(path);
    return () => {
      close(path);
      s.undoStack = [];
      s.redoStack = [];
    };
  }, [path]);

  useEffect(() => {
    const element = container.current!;
    const resize = new ResizeObserver(() => {
      s.containerWidth = element.clientWidth;
      update();
    });
    resize.observe(element);
    // React registers wheel listeners as passive, which would ignore preventDefault.
    element.addEventListener("wheel", onwheel, { passive: false });
    const onbeforeunload = () => latest.current.path && saveTyped.flush(latest.current.path);
    window.addEventListener("keydown", onkeydown);
    window.addEventListener("beforeunload", onbeforeunload);
    return () => {
      resize.disconnect();
      observer.disconnect();
      element.removeEventListener("wheel", onwheel);
      window.removeEventListener("keydown", onkeydown);
      window.removeEventListener("beforeunload", onbeforeunload);
    };
  }, []);

  async function load(pdf: string) {
    try {
      let opened;
      try {
        opened = await openPDF(await api.readPDF(pdf));
      } catch {
        throw new Error("This file could not be opened as a PDF.");
      }
      if (pdf !== latest.current.path) return opened.loadingTask.destroy();
      const [pdfPages, position] = await Promise.all([
        Promise.all(Array.from({ length: opened.numPages }, (_, i) => opened.getPage(i + 1))),
        api.readPosition(pdf),
      ]);
      s.doc = opened;
      s.sheets = pdfPages.map((pdfPage) => ({ pdfPage, element: null, drawnScale: 0, visible: false, task: null }));
      s.scale = position?.scale ?? null;
      s.currentPage = Math.min(position?.page ?? 0, pdfPages.length - 1);
      s.anchor = { page: s.currentPage, offset: 0 };
      s.pages = pdfPages.map((page) => page.getViewport({ scale: 1 }));
      update();
      [s.notes, s.annotations] = await Promise.all([api.readNotes(pdf), api.readAnnotations(pdf)]);
      update();
    } catch (error) {
      onerror(error);
    }
  }

  function close(pdf: string) {
    saveTyped.flush(pdf);
    savePosition.flush(pdf);
    observer.disconnect();
    for (const sheet of s.sheets) sheet.task?.cancel();
    s.doc?.loadingTask.destroy();
    Object.assign(s, {
      doc: null,
      sheets: [],
      rows: [],
      pages: [],
      notes: null,
      annotations: null,
      picker: null,
      editingNote: null,
      pickingColor: false,
      selectedImage: null,
      scale: null,
    });
    update();
  }

  // Keep the current page and offset in view while the page size changes: the place is read
  // while rendering, before the pages resize, and scrolled back to once they have.
  const scale = effective();
  if (scale !== s.laidOut) captureAnchor();
  useLayoutEffect(() => {
    s.laidOut = scale;
    s.sheets.forEach((sheet, index) => {
      const element = s.rows[index]?.querySelector<HTMLElement>(".render");
      if (!element || sheet.element === element) return;
      sheet.element = element;
      element.dataset.index = String(index);
      observer.observe(element);
    });
    restoreAnchor();
  });

  function captureAnchor() {
    const row = s.rows[s.currentPage];
    const scroller = container.current;
    if (row && scroller && !s.anchor) s.anchor = { page: s.currentPage, offset: (scroller.scrollTop - row.offsetTop) / row.offsetHeight };
  }

  function restoreAnchor() {
    const row = s.anchor && s.rows[s.anchor.page];
    if (!s.anchor || !row) return;
    container.current!.scrollTop = row.offsetTop + s.anchor.offset * row.offsetHeight;
    s.anchor = null;
    scheduleRedraw();
  }

  const redrawTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  function scheduleRedraw() {
    clearTimeout(redrawTimer.current);
    // Pinching fires continuously, and the sidebar slides for 0.2s; the stretched old canvas stands in until both settle.
    redrawTimer.current = setTimeout(() => s.sheets.filter((sheet) => sheet.visible).forEach(draw), 250);
  }

  async function draw(sheet: Sheet) {
    const scale = effective();
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

  function onscroll() {
    if (s.picker) {
      s.picker = null;
      update();
    }
    const top = container.current!.scrollTop + 1;
    const index = s.rows.findIndex((row) => row && row.offsetTop + row.offsetHeight > top);
    if (index >= 0 && index !== s.currentPage) {
      s.currentPage = index;
      if (latest.current.path) savePosition(latest.current.path);
    }
  }

  // Trackpad pinches arrive as ctrl+wheel events.
  function onwheel(event: WheelEvent) {
    if (!event.ctrlKey) return;
    event.preventDefault();
    zoom(effective() * Math.exp(-event.deltaY * 0.01));
  }

  function zoom(next: number | null) {
    const path = latest.current.path;
    if (!s.doc || !path) return;
    s.scale = next == null ? null : Math.min(8, Math.max(0.1, next));
    savePosition(path);
    update();
  }

  /** The selected text's line boxes on each page, as page fractions. */
  function selectedRects() {
    const selection = getSelection();
    if (!s.annotations || !selection?.rangeCount || selection.isCollapsed) return [];
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
    s.picker = first ? { x: first.left, y: first.top < 60 ? first.bottom + 8 : first.top - 48 } : null;
    update();
  }

  // Only called once a PDF has loaded, so the fallbacks never apply.
  const current = (): Step => ({
    notes: structuredClone(s.notes) ?? {},
    annotations: structuredClone(s.annotations) ?? { highlights: [] },
  });

  /**
   * Remembers the notes and annotations before a change. Changes with the same `key` less than
   * a second apart, like typing, merge into one step.
   */
  function record(key?: string) {
    const top = s.undoStack.at(-1);
    const at = Date.now();
    s.redoStack = [];
    if (key && top?.key === key && at - (top.at ?? 0) < 1000) top.at = at;
    else s.undoStack.push({ ...current(), key, at });
  }

  // A PDF step holds both versions: undo restores `before`, redo restores `after`.
  async function step(from: Step[], to: Step[], version: keyof Versions) {
    const state = from.at(-1);
    const path = latest.current.path;
    if (s.editingPages || !state || !s.annotations || !path) return;
    const versions = state.pdf;
    if (!versions) {
      from.pop();
      to.push(current());
      s.notes = state.notes;
      s.annotations = state.annotations;
      s.editingNote = null;
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
    if (!s.annotations) return;
    record();
    for (const [page, found] of Map.groupBy(selectedRects(), (f) => f.page)) {
      s.annotations.highlights.push({ id: crypto.randomUUID(), page, color, rects: mergeLines(found.map((f) => f.rect)) });
    }
    getSelection()?.removeAllRanges();
    s.picker = null;
    saveAnnotations();
  }

  // Highlights ignore the pointer so text stays selectable; right-clicks are hit-tested instead.
  async function pageMenu(event: ReactMouseEvent<HTMLElement>, page: number) {
    const box = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - box.left) / box.width;
    const y = (event.clientY - box.top) / box.height;
    const hit = s.annotations?.highlights.findLast(
      (h) => h.page === page && h.rects.some(([rx, ry, rw, rh]) => x >= rx && x <= rx + rw && y >= ry && y <= ry + rh),
    );
    const image = (event.target as Element).closest<HTMLElement>(".page-image")?.dataset.id;
    const separator: MenuItem = { type: "separator" };
    const removeHighlight: MenuItem[] = hit ? [{ id: "removeHighlight", label: "Remove Highlight" }, separator] : [];
    const deletePage: MenuItem[] = s.pages.length > 1 ? [separator, { id: "delete", label: "Delete Page" }] : [];
    const imageItems: MenuItem[] = image ? [{ id: "removeImage", label: "Remove Image" }, separator] : [];
    const chosen = await contextMenu([
      ...imageItems,
      ...removeHighlight,
      { id: "insertBlank", label: "Insert Blank Page After" },
      { id: "duplicate", label: "Duplicate Page" },
      separator,
      { id: "rotateLeft", label: "Rotate Left" },
      { id: "rotateRight", label: "Rotate Right" },
      ...deletePage,
    ]);
    if (chosen === "removeHighlight" && s.annotations && hit) {
      record();
      s.annotations.highlights = s.annotations.highlights.filter((h) => h.id !== hit.id);
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
      s.undoStack.push({ ...before, pdf: versions });
      s.redoStack = [];
    });
  }

  /** Runs `change` on the file, then reloads it. */
  async function changePDF(change: (pdf: string) => Promise<void>) {
    const pdf = latest.current.path;
    if (!pdf || s.editingPages) return;
    s.editingPages = true;
    try {
      // The library moves the saved position along with the pages, so it must be current first.
      saveTyped.flush(pdf);
      savePosition.flush(pdf);
      await api.savePosition(pdf, { page: s.currentPage, scale: s.scale ?? undefined });
      await change(pdf);
      if (pdf !== latest.current.path) return;
      close(pdf);
      // The reload sets an anchor, which the layout effect scrolls back to.
      await load(pdf);
    } catch (error) {
      onerror(error);
    } finally {
      s.editingPages = false;
    }
  }

  function setEditingNote(id: string | null) {
    s.editingNote = id;
    s.pickingColor = false;
  }

  function placeNote(event: ReactMouseEvent<HTMLElement>, page: number) {
    if (!latest.current.placingNote || !s.annotations || (event.target as Element).closest(".page-note, .page-image")) return;
    const box = event.currentTarget.getBoundingClientRect();
    const id = crypto.randomUUID();
    record(id);
    s.annotations.pageNotes ??= [];
    s.annotations.pageNotes.push({
      id,
      page,
      x: (event.clientX - box.left) / box.width,
      y: (event.clientY - box.top) / box.height,
      text: "",
    });
    latest.current.onPlacingNoteChange?.(false);
    editNoteText(id);
  }

  function editNoteText(id: string) {
    setEditingNote(id);
    // Renders the textarea so it can take focus.
    flushSync(update);
    document.getElementById(id)?.focus();
  }

  function editPageNote(note: PageNote, text: string) {
    if (!path) return;
    record(note.id);
    note.text = text;
    saveTyped(path);
    update();
  }

  // Sizes are kept at scale 1 so they scale with the page.
  function resizeNote(note: PageNote, textarea: HTMLTextAreaElement) {
    const w = Math.round(textarea.offsetWidth / effective());
    const h = Math.round(textarea.offsetHeight / effective());
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

  function colorText(note: PageNote, color: string) {
    s.pickingColor = false;
    update();
    if ((note.color ?? TEXT_COLORS[0][0]) === color) return;
    record();
    note.color = color;
    saveAnnotations();
  }

  /** Runs `move` until the pointer is released; the whole gesture is one undo step, saved once. */
  function followPointer(move: (e: PointerEvent) => void) {
    let moved = false;
    const onmove = (e: PointerEvent) => {
      if (!moved) record();
      moved = true;
      move(e);
      update();
    };
    const stop = () => {
      removeEventListener("pointermove", onmove);
      removeEventListener("pointerup", stop);
      if (moved) saveAnnotations();
    };
    addEventListener("pointermove", onmove);
    addEventListener("pointerup", stop);
  }

  function dragNote(event: ReactPointerEvent<HTMLElement>, note: PageNote | PageImage) {
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
  function resizeImage(event: ReactPointerEvent, image: PageImage) {
    event.stopPropagation();
    event.preventDefault();
    const start = { x: event.clientX, w: image.w, ratio: image.h / image.w };
    followPointer((e) => {
      image.w = Math.max(16, Math.round(start.w + (e.clientX - start.x) / effective()));
      image.h = Math.round(image.w * start.ratio);
    });
  }

  function removeImage(id: string) {
    if (!s.annotations) return;
    record();
    s.annotations.pageImages = s.annotations.pageImages?.filter((i) => i.id !== id);
    if (s.selectedImage === id) s.selectedImage = null;
    saveAnnotations();
  }

  function onpointerdown(event: ReactPointerEvent) {
    if (s.selectedImage && !(event.target as Element).closest(".page-image.selected")) {
      s.selectedImage = null;
      update();
    }
  }

  function onkeydown(event: KeyboardEvent) {
    if (!s.selectedImage) return;
    if (event.key === "Escape") {
      s.selectedImage = null;
      update();
    } else if ((event.key === "Backspace" || event.key === "Delete") && !(event.target as Element).closest("input, textarea")) {
      event.preventDefault();
      removeImage(s.selectedImage);
    }
  }

  /** Asks for an image and places it in the middle of the visible part of the current page. */
  async function insertImage() {
    const file = await pickImage();
    if (!file || !s.annotations) return;
    let src: string, width: number, height: number;
    try {
      ({ src, width, height } = await shrinkImage(file));
    } catch {
      return onerror(new Error("This image could not be opened."));
    }
    const page = s.currentPage + 1;
    const size = s.pages[s.currentPage];
    const sheet = s.rows[s.currentPage]?.querySelector(".sheet");
    if (!s.annotations || !size || !sheet) return;
    const w = Math.min(width, size.width / 2, ((size.height / 2) * width) / height);
    const h = Math.round((w * height) / width);
    const box = sheet.getBoundingClientRect();
    const view = container.current!.getBoundingClientRect();
    const middle = (view.top + view.height / 2 - box.top) / box.height;
    record();
    s.annotations.pageImages ??= [];
    s.annotations.pageImages.push({
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
    if (s.editingNote === note.id) setEditingNote(null);
    update();
    if (note.text || !s.annotations) return;
    // A note placed and left empty never happened, so its step goes too.
    const top = s.undoStack.at(-1);
    if (top?.key === note.id && !top.annotations.pageNotes?.some((n) => n.id === note.id)) s.undoStack.pop();
    else record();
    s.annotations.pageNotes = s.annotations.pageNotes?.filter((n) => n.id !== note.id);
    saveAnnotations();
  }

  /** Saves the annotations and shows the change. */
  function saveAnnotations() {
    update();
    const path = latest.current.path;
    if (!path || !s.annotations) return;
    api.saveAnnotations(path, s.annotations).catch(onerror);
  }

  function editNote(page: number, text: string) {
    if (!path || !s.notes) return;
    record(`note ${page}`);
    s.notes[page] = text;
    api.saveNotes(path, s.notes).catch(onerror);
    update();
  }

  useImperativeHandle(ref, () => ({
    zoom,
    zoomIn: () => zoom(effective() * 1.25),
    zoomOut: () => zoom(effective() / 1.25),
    undo: () => step(s.undoStack, s.redoStack, "before"),
    redo: () => step(s.redoStack, s.undoStack, "after"),
    insertImage,
  }));

  const editedNote = s.annotations?.pageNotes?.find((n) => n.id === s.editingNote);
  const editingText = editedNote != null;
  useEffect(() => latest.current.onEditingTextChange?.(editingText), [editingText]);

  const { annotations } = s;
  const notesShown = showingNotes && s.notes != null;

  return (
    <>
      <div
        className={`pages ${placingNote ? "placing" : ""}`}
        role="document"
        ref={container}
        style={{ paddingLeft: inset }}
        onScroll={onscroll}
        onPointerDown={onpointerdown}
        onPointerUp={onpointerup}
      >
        {s.pages.map((page, index) => (
          <div className="page-row" key={index} ref={(row) => void (s.rows[index] = row)}>
            <div
              className="sheet"
              role="group"
              aria-label={`Page ${index + 1}`}
              data-page={index + 1}
              style={{ width: page.width * scale, height: page.height * scale }}
              onContextMenu={(event) => pageMenu(event, index + 1)}
              onClick={(event) => placeNote(event, index + 1)}
            >
              <div className="render"></div>
              {annotations?.pageImages
                ?.filter((image) => image.page === index + 1)
                .map((image) => (
                  <div
                    key={image.id}
                    className={`page-image ${s.selectedImage === image.id ? "selected" : ""}`}
                    role="img"
                    aria-label={`Image on page ${index + 1}`}
                    data-id={image.id}
                    style={{
                      left: `min(${image.x * 100}%, calc(100% - ${image.w * scale}px))`,
                      top: `min(${image.y * 100}%, calc(100% - ${image.h * scale}px))`,
                      width: image.w * scale,
                      height: image.h * scale,
                    }}
                    onPointerDown={(event) => s.selectedImage === image.id && dragNote(event, image)}
                    onDoubleClick={() => {
                      s.selectedImage = image.id;
                      update();
                    }}
                  >
                    <img src={image.src} alt="" draggable="false" />
                    {s.selectedImage === image.id && (
                      <div className="resize-handle" role="presentation" onPointerDown={(event) => resizeImage(event, image)}></div>
                    )}
                  </div>
                ))}
              {annotations?.pageNotes
                ?.filter((note) => note.page === index + 1)
                .map((note) => {
                  const size = { width: (note.w ?? NOTE_SIZE[0]) * scale, height: (note.h ?? NOTE_SIZE[1]) * scale };
                  return (
                    // Drag the note by its text; double-click to edit it.
                    <div
                      key={note.id}
                      className={`page-note ${s.editingNote === note.id ? "editing" : ""}`}
                      role="group"
                      aria-label={`Note on page ${index + 1}`}
                      style={
                        {
                          "--note-scale": scale,
                          "--note-size": note.size ? `${note.size}px` : undefined,
                          "--note-color": note.color,
                          fontWeight: note.bold ? "bold" : undefined,
                          fontStyle: note.italic ? "italic" : undefined,
                          textDecoration: note.underline ? "underline" : undefined,
                          left: `min(${note.x * 100}%, calc(100% - ${((note.w ?? NOTE_SIZE[0]) + 12) * scale}px))`,
                          top: `min(${note.y * 100}%, calc(100% - ${((note.h ?? NOTE_SIZE[1]) + 12) * scale}px))`,
                        } as CSSProperties
                      }
                      onPointerDown={(event) => dragNote(event, note)}
                      onDoubleClick={() => editNoteText(note.id)}
                    >
                      {s.editingNote === note.id ? (
                        <textarea
                          id={note.id}
                          aria-label="Note text"
                          placeholder="Text"
                          value={note.text}
                          style={size}
                          onMouseUp={(event) => resizeNote(note, event.currentTarget)}
                          onChange={(event) => editPageNote(note, event.currentTarget.value)}
                          onBlur={() => dropEmptyNote(note)}
                        ></textarea>
                      ) : (
                        // Laid out like the textarea; only the span's line boxes take presses.
                        <div className="note-text" style={size}>
                          <span>{note.text}</span>
                        </div>
                      )}
                    </div>
                  );
                })}
              {annotations?.highlights
                .filter((h) => h.page === index + 1)
                .flatMap((h) =>
                  h.rects.map(([x, y, width, height], i) => (
                    <div
                      key={`${h.id}-${i}`}
                      className="highlight"
                      data-color={h.color}
                      style={{ left: `${x * 100}%`, top: `${y * 100}%`, width: `${width * 100}%`, height: `${height * 100}%` }}
                    ></div>
                  )),
                )}
            </div>
            {notesShown && (
              <label className="note">
                <textarea
                  placeholder="Add a note…"
                  aria-label={`Note for page ${index + 1}`}
                  value={s.notes?.[index + 1] ?? ""}
                  onChange={(event) => editNote(index + 1, event.currentTarget.value)}
                ></textarea>
              </label>
            )}
          </div>
        ))}
      </div>

      {/* Preventing mousedown keeps the note focused, so it stays in editing. */}
      <AnimatePresence initial={false}>
        {editedNote && (
          <motion.div
            key="text-format"
            className="bottom-toolbar text-format floating"
            role="toolbar"
            tabIndex={-1}
            style={{ "--inset": `${inset}px`, x: "-50%" } as CSSProperties}
            {...grow(0.9)}
            onMouseDown={(event) => event.preventDefault()}
          >
            {TEXT_STYLES.map(([style, label]) => (
              <button
                key={style}
                className={`icon-button ${editedNote[style] ? "active" : ""}`}
                title={label}
                aria-label={label}
                aria-pressed={!!editedNote[style]}
                onClick={() => toggleTextStyle(editedNote, style)}
              >
                <Icon name={style} />
              </button>
            ))}
            <div className="toolbar-separator"></div>
            <button
              className="icon-button"
              title="Smaller Text"
              aria-label="Smaller Text"
              aria-disabled={(editedNote.size ?? 14) <= TEXT_SIZES[0]}
              onClick={() => resizeText(editedNote, -1)}
            >
              <Icon name="minus" />
            </button>
            <span className="text-size">{editedNote.size ?? 14}</span>
            <button
              className="icon-button"
              title="Larger Text"
              aria-label="Larger Text"
              aria-disabled={(editedNote.size ?? 14) >= TEXT_SIZES.at(-1)!}
              onClick={() => resizeText(editedNote, 1)}
            >
              <Icon name="add" />
            </button>
            <div className="toolbar-separator"></div>
            {/* Only the current colour shows; clicking it slides the others out around it. */}
            <div className="text-colors">
              <AnimatePresence initial={false}>
                {TEXT_COLORS.map(([color, label]) => {
                  const current = (editedNote.color ?? TEXT_COLORS[0][0]) === color;
                  return (
                    (current || s.pickingColor) && (
                      // Padded so the clip leaves room for the active swatch's outline.
                      <motion.span key={color} className="-m-1 flex p-1" {...slide}>
                        <button
                          className={`swatch ${current && s.pickingColor ? "active" : ""}`}
                          style={{ background: color }}
                          title={s.pickingColor ? label : "Text Colour"}
                          aria-label={s.pickingColor ? `${label} Text` : "Text Colour"}
                          aria-pressed={s.pickingColor ? current : undefined}
                          aria-expanded={current ? s.pickingColor : undefined}
                          onClick={() => {
                            if (s.pickingColor) colorText(editedNote, color);
                            else {
                              s.pickingColor = true;
                              update();
                            }
                          }}
                        ></button>
                      </motion.span>
                    )
                  );
                })}
              </AnimatePresence>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {s.picker && (
        <div className="highlight-picker floating" style={{ left: s.picker.x, top: s.picker.y }}>
          {COLORS.map((color) => (
            // Keeping focus where it is stops the click from clearing the selection.
            <button
              key={color}
              className="swatch"
              data-color={color}
              title="Highlight"
              aria-label={`Highlight ${color}`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => highlight(color)}
            ></button>
          ))}
        </div>
      )}
    </>
  );
}
