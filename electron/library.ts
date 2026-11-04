import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PDFDocument, degrees } from "pdf-lib";

/** A rect as fractions of its page. */
export type Rect = [x: number, y: number, width: number, height: number];
/** 1-based page numbers throughout. */
export interface Highlight {
  id: string;
  page: number;
  color: string;
  rects: Rect[];
}
/** `x` and `y` are fractions of the page; `w` and `h` are CSS pixels at scale 1. */
export interface PageNote {
  id: string;
  page: number;
  x: number;
  y: number;
  w?: number;
  h?: number;
  text: string;
}
/** Placed like a page note; `src` is a data URL so the image travels with the annotations file. */
export interface PageImage {
  id: string;
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  src: string;
}
export interface Annotations {
  highlights: Highlight[];
  /** Missing in files from before page notes. */
  pageNotes?: PageNote[];
  /** Missing in files from before page images. */
  pageImages?: PageImage[];
}
/** Notes keyed by 1-based page number. */
export type Notes = Record<string, string>;
/** `page` is 0-based; a missing scale means fit to width. */
export interface Position {
  page: number;
  scale?: number;
}
export type PageEdit =
  | { action: "insertBlank" | "duplicate" | "delete"; page: number }
  | { action: "rotate"; page: number; rotate: 90 | -90 };
/** Version ids for `restoreVersion`. */
export interface Versions {
  before: string;
  after: string;
}
export interface Folder {
  name: string;
  path: string;
  pdfs: { name: string; path: string }[];
  markdown: { name: string; path: string }[];
}

/** Turns a rect with its page: clockwise for 90, anticlockwise for -90. */
const turnRect = ([x, y, w, h]: Rect, turn: 90 | -90): Rect =>
  turn === 90 ? [1 - y - h, x, h, w] : [y, 1 - x - w, h, w];

/** Folders of PDFs and markdown files under `libraryPath`; PDFs may have sidecar files next to them. */
export function createLibrary(
  libraryPath: string,
  { trash, versionsPath }: { trash: (file: string) => Promise<unknown>; versionsPath: string },
) {
  fs.mkdirSync(libraryPath, { recursive: true });
  const root = fs.realpathSync(libraryPath);

  const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

  function inLibrary(target: string) {
    const resolved = path.resolve(target);
    if (!resolved.startsWith(root + path.sep)) throw new Error("That file is outside the library.");
    return resolved;
  }

  function validatedName(name: string) {
    name = name.trim();
    // Windows' reserved characters are refused everywhere so the library stays portable.
    if (!name || name === "." || name === ".." || /[\\/:*?"<>|\0]/.test(name)) {
      throw new Error('Enter a name without any of these characters: \\ / : * ? " < > |');
    }
    return name;
  }

  const notesPath = (pdf: string) => pdf.replace(/\.pdf$/i, ".notes.json");
  const positionPath = (pdf: string) => pdf.replace(/\.pdf$/i, ".position.json");
  const annotationsPath = (pdf: string) => pdf.replace(/\.pdf$/i, ".annotations.json");
  const sidecars = (file: string) =>
    /\.pdf$/i.test(file) ? [notesPath(file), positionPath(file), annotationsPath(file)] : [];

  function listLibrary(): Folder[] {
    const entries = (dir: string) =>
      fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => byName(a.name, b.name));
    return entries(root)
      .filter((e) => e.isDirectory())
      .map((folder) => {
        const folderPath = path.join(root, folder.name);
        const files = entries(folderPath).filter((e) => e.isFile());
        const withExtension = (extension: string) =>
          files
            .filter((e) => e.name.toLowerCase().endsWith(extension))
            .map((e) => ({ name: e.name, path: path.join(folderPath, e.name) }));
        return { name: folder.name, path: folderPath, pdfs: withExtension(".pdf"), markdown: withExtension(".md") };
      });
  }

  function createFolder(name: string) {
    const folder = path.join(root, validatedName(name));
    if (fs.existsSync(folder)) throw new Error("A folder with that name already exists.");
    fs.mkdirSync(folder);
    return folder;
  }

  function importPDF(source: string, folder: string) {
    folder = inLibrary(folder);
    const header = Buffer.alloc(1024);
    const fd = fs.openSync(source, "r");
    const read = fs.readSync(fd, header, 0, header.length, 0);
    fs.closeSync(fd);
    // shortcut: checks the %PDF- header only, so a truncated PDF still imports; parse it if that matters.
    if (!source.toLowerCase().endsWith(".pdf") || !header.subarray(0, read).includes("%PDF-")) {
      throw new Error("This file could not be opened as a PDF.");
    }
    const destination = path.join(folder, path.basename(source));
    try {
      // COPYFILE_EXCL refuses to overwrite an existing file.
      fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`“${path.basename(source)}” is already in this folder.`);
      }
      throw error;
    }
    return destination;
  }

  /** Renames a PDF or markdown file, keeping its extension. */
  function renameFile(source: string, name: string) {
    source = inLibrary(source);
    const extension = path.extname(source);
    name = name.trim();
    if (name.toLowerCase().endsWith(extension.toLowerCase())) name = name.slice(0, -extension.length);
    const destination = path.join(path.dirname(source), validatedName(name) + extension);
    if (destination === source) return source;
    // A case-only rename finds the source itself on case-insensitive volumes.
    if (destination.toLowerCase() !== source.toLowerCase() && fs.existsSync(destination)) {
      throw new Error(`“${path.basename(destination)}” already exists.`);
    }
    fs.renameSync(source, destination);
    const moved: [string, string][] = [];
    try {
      for (const [from, to] of sidecars(source).map((file, i) => [file, sidecars(destination)[i]])) {
        if (!fs.existsSync(from)) continue;
        fs.renameSync(from, to);
        moved.push([from, to]);
      }
    } catch (error) {
      // Keep the PDF and its sidecars together.
      for (const [from, to] of moved.reverse()) fs.renameSync(to, from);
      fs.renameSync(destination, source);
      throw error;
    }
    return destination;
  }

  async function trashFile(file: string) {
    file = inLibrary(file);
    await trash(file);
    for (const sidecar of sidecars(file)) if (fs.existsSync(sidecar)) await trash(sidecar);
  }

  function markdownFile(file: string) {
    file = inLibrary(file);
    if (!/\.md$/i.test(file)) throw new Error("That isn't a markdown file.");
    return file;
  }

  function createMarkdown(folder: string, name: string) {
    folder = inLibrary(folder);
    const file = path.join(folder, validatedName(name.trim().replace(/\.md$/i, "")) + ".md");
    try {
      // "wx" refuses to overwrite an existing file.
      fs.writeFileSync(file, "", { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`“${path.basename(file)}” already exists.`);
      throw error;
    }
    return file;
  }

  async function saveMarkdown(file: string, text: string) {
    file = markdownFile(file);
    if (typeof text !== "string") throw new Error("Markdown must be text.");
    await fs.promises.writeFile(file + ".tmp", text);
    await fs.promises.rename(file + ".tmp", file);
  }

  /** Unreadable sidecars throw so the renderer never overwrites them. */
  function readSidecar<T>(file: string, what: string): T | null {
    if (!fs.existsSync(file)) return null;
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      throw new Error(`The ${what} in “${path.basename(file)}” could not be read.`);
    }
  }

  /** Null removes the file. */
  function writeSidecar(file: string, value: unknown) {
    if (value == null) {
      fs.rmSync(file, { force: true });
      return;
    }
    fs.writeFileSync(file + ".tmp", JSON.stringify(value, null, 2));
    fs.renameSync(file + ".tmp", file);
  }

  const readNotes = (pdf: string) => readSidecar<Notes>(notesPath(inLibrary(pdf)), "notes") ?? {};

  function saveNotes(pdf: string, notes: Notes) {
    const kept = Object.fromEntries(Object.entries(notes).filter(([, text]) => text));
    writeSidecar(notesPath(inLibrary(pdf)), Object.keys(kept).length ? kept : null);
  }

  const readAnnotations = (pdf: string) =>
    readSidecar<Annotations>(annotationsPath(inLibrary(pdf)), "annotations") ?? { highlights: [], pageNotes: [] };

  function saveAnnotations(pdf: string, annotations: Annotations) {
    if (!Array.isArray(annotations?.highlights)) throw new Error("Annotations must hold a list of highlights.");
    const empty = !annotations.highlights.length && !annotations.pageNotes?.length && !annotations.pageImages?.length;
    writeSidecar(annotationsPath(inLibrary(pdf)), empty ? null : annotations);
  }

  async function readPosition(pdf: string): Promise<Position | null> {
    const value = await fs.promises.readFile(positionPath(inLibrary(pdf)), "utf8").catch(() => null);
    try {
      return value && JSON.parse(value);
    } catch {
      return null;
    }
  }

  // Losing a reading position is harmless, so write failures are ignored.
  async function savePosition(pdf: string, position: Position) {
    await fs.promises.writeFile(positionPath(inLibrary(pdf)), JSON.stringify(position)).catch(() => {});
  }

  /** Keeps a copy of a PDF's contents under `versionsPath` for undo and returns its id. */
  async function keepVersion(bytes: Uint8Array) {
    await fs.promises.mkdir(versionsPath, { recursive: true });
    const id = crypto.randomUUID() + ".pdf";
    await fs.promises.writeFile(path.join(versionsPath, id), bytes);
    return id;
  }

  /** Puts back a version kept by `editPage`. Notes and annotations are the caller's to restore. */
  async function restoreVersion(pdf: string, id: string) {
    pdf = inLibrary(pdf);
    // The id comes from the renderer, so it may only name a file directly inside the versions folder.
    if (!/^[\w-]+\.pdf$/.test(String(id))) throw new Error("That version doesn't exist.");
    const temp = pdf + ".tmp";
    await fs.promises.copyFile(path.join(versionsPath, id), temp);
    fs.renameSync(temp, pdf);
  }

  /**
   * Inserts a blank page or a copy after the 1-based `page`, deletes it, or rotates it by `rotate` (±90).
   * The original file goes to the Trash, and notes, annotations and the reading position follow their pages.
   */
  async function editPage(pdf: string, edit: PageEdit): Promise<Versions> {
    pdf = inLibrary(pdf);
    const { action, page } = edit;
    // Unreadable sidecars throw here, before anything changes.
    const notes = readNotes(pdf);
    const annotations = readAnnotations(pdf);
    const position = await readPosition(pdf);

    const original = await fs.promises.readFile(pdf);
    let doc: PDFDocument;
    try {
      doc = await PDFDocument.load(original);
    } catch {
      throw new Error("The pages of this PDF can't be edited because it is encrypted or damaged.");
    }
    const count = doc.getPageCount();
    if (!Number.isInteger(page) || page < 1 || page > count) throw new Error("That page doesn't exist.");
    const index = page - 1;
    /** Where an old page number ends up, or null once deleted. */
    let moved = (p: number): number | null => p;
    let turn: 90 | -90 | null = null;
    if (action === "insertBlank" || action === "duplicate") {
      const source = doc.getPage(index);
      if (action === "duplicate") doc.insertPage(page, (await doc.copyPages(doc, [index]))[0]);
      else doc.insertPage(page, [source.getWidth(), source.getHeight()]).setRotation(source.getRotation());
      moved = (p) => (p > page ? p + 1 : p);
    } else if (action === "delete") {
      if (count === 1) throw new Error("A PDF needs at least one page.");
      doc.removePage(index);
      moved = (p) => (p === page ? null : p > page ? p - 1 : p);
    } else if (action === "rotate" && (edit.rotate === 90 || edit.rotate === -90)) {
      const target = doc.getPage(index);
      target.setRotation(degrees((target.getRotation().angle + edit.rotate + 360) % 360));
      turn = edit.rotate;
    } else {
      throw new Error("Unknown page edit.");
    }

    const edited = await doc.save();
    const versions = { before: await keepVersion(original), after: await keepVersion(edited) };
    const temp = pdf + ".tmp";
    await fs.promises.writeFile(temp, edited);
    try {
      await trash(pdf);
    } catch (error) {
      fs.rmSync(temp, { force: true });
      throw error;
    }
    fs.renameSync(temp, pdf);

    const follow = <T extends { page: number }>(items: T[] = [], turnItem: (item: T, turn: 90 | -90) => T) =>
      items.flatMap((item) => {
        const to = moved(item.page);
        if (!to) return [];
        return [turn && to === page ? turnItem(item, turn) : { ...item, page: to }];
      });
    saveNotes(
      pdf,
      Object.fromEntries(Object.entries(notes).flatMap(([p, text]) => {
        const to = moved(Number(p));
        return to ? [[to, text]] : [];
      })),
    );
    saveAnnotations(pdf, {
      ...annotations,
      highlights: follow(annotations.highlights, (h, t) => ({ ...h, rects: h.rects.map((rect) => turnRect(rect, t)) })),
      // shortcut: only the anchor corner turns, so a note or image may shift by its own size; fine for small ones.
      pageNotes: follow(annotations.pageNotes, (note, t) => {
        const [x, y] = turnRect([note.x, note.y, 0, 0], t);
        return { ...note, x, y };
      }),
      pageImages: follow(annotations.pageImages, (image, t) => {
        const [x, y] = turnRect([image.x, image.y, 0, 0], t);
        return { ...image, x, y };
      }),
    });
    // Positions are 0-based; a deleted current page gives way to the one after it.
    if (position?.page != null) {
      await savePosition(pdf, { ...position, page: (moved(position.page + 1) ?? Math.min(page, count - 1)) - 1 });
    }
    return versions;
  }

  return {
    inLibrary,
    listLibrary,
    createFolder,
    importPDF,
    renameFile,
    trashFile,
    createMarkdown,
    readMarkdown: (file: string) => fs.promises.readFile(markdownFile(file), "utf8"),
    saveMarkdown,
    readPDF: (pdf: string) => fs.promises.readFile(inLibrary(pdf)),
    readNotes,
    saveNotes,
    readAnnotations,
    saveAnnotations,
    readPosition,
    savePosition,
    editPage,
    restoreVersion,
  };
}
