const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { PDFDocument, degrees } = require("pdf-lib");

/** Turns an [x, y, width, height] rect in page fractions with its page: clockwise for 90, anticlockwise for -90. */
const turnRect = ([x, y, w, h], turn) => (turn === 90 ? [1 - y - h, x, h, w] : [y, 1 - x - w, h, w]);

/** Folders of PDFs under `libraryPath`, each with optional sidecar files next to it. */
function createLibrary(libraryPath, { trash, versionsPath }) {
  fs.mkdirSync(libraryPath, { recursive: true });
  const root = fs.realpathSync(libraryPath);

  const byName = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

  function inLibrary(target) {
    const resolved = path.resolve(target);
    if (!resolved.startsWith(root + path.sep)) throw new Error("That file is outside the library.");
    return resolved;
  }

  function validatedName(name) {
    name = name.trim();
    // Windows' reserved characters are refused everywhere so the library stays portable.
    if (!name || name === "." || name === ".." || /[\\/:*?"<>|\0]/.test(name)) {
      throw new Error('Enter a name without any of these characters: \\ / : * ? " < > |');
    }
    return name;
  }

  const notesPath = (pdf) => pdf.replace(/\.pdf$/i, ".notes.json");
  const positionPath = (pdf) => pdf.replace(/\.pdf$/i, ".position.json");
  const annotationsPath = (pdf) => pdf.replace(/\.pdf$/i, ".annotations.json");
  const sidecars = (pdf) => [notesPath(pdf), positionPath(pdf), annotationsPath(pdf)];

  function listLibrary() {
    const entries = (dir) => fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => byName(a.name, b.name));
    return entries(root)
      .filter((e) => e.isDirectory())
      .map((folder) => {
        const folderPath = path.join(root, folder.name);
        return {
          name: folder.name,
          path: folderPath,
          pdfs: entries(folderPath)
            .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".pdf"))
            .map((e) => ({ name: e.name, path: path.join(folderPath, e.name) })),
        };
      });
  }

  function createFolder(name) {
    const folder = path.join(root, validatedName(name));
    if (fs.existsSync(folder)) throw new Error("A folder with that name already exists.");
    fs.mkdirSync(folder);
    return folder;
  }

  function importPDF(source, folder) {
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
      if (error.code === "EEXIST") throw new Error(`“${path.basename(source)}” is already in this folder.`);
      throw error;
    }
    return destination;
  }

  function renamePDF(pdf, name) {
    pdf = inLibrary(pdf);
    name = name.trim().replace(/\.pdf$/i, "");
    const destination = path.join(path.dirname(pdf), validatedName(name) + ".pdf");
    if (destination === pdf) return pdf;
    // A case-only rename finds the source itself on case-insensitive volumes.
    if (destination.toLowerCase() !== pdf.toLowerCase() && fs.existsSync(destination)) {
      throw new Error(`“${path.basename(destination)}” already exists.`);
    }
    fs.renameSync(pdf, destination);
    const moved = [];
    try {
      for (const [from, to] of sidecars(pdf).map((file, i) => [file, sidecars(destination)[i]])) {
        if (!fs.existsSync(from)) continue;
        fs.renameSync(from, to);
        moved.push([from, to]);
      }
    } catch (error) {
      // Keep the PDF and its sidecars together.
      for (const [from, to] of moved.reverse()) fs.renameSync(to, from);
      fs.renameSync(destination, pdf);
      throw error;
    }
    return destination;
  }

  async function trashPDF(pdf) {
    pdf = inLibrary(pdf);
    await trash(pdf);
    for (const file of sidecars(pdf)) if (fs.existsSync(file)) await trash(file);
  }

  /** Unreadable sidecars throw so the renderer never overwrites them. */
  function readSidecar(file, what) {
    if (!fs.existsSync(file)) return null;
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      throw new Error(`The ${what} in “${path.basename(file)}” could not be read.`);
    }
  }

  /** Null removes the file. */
  function writeSidecar(file, value) {
    if (value == null) {
      fs.rmSync(file, { force: true });
      return;
    }
    fs.writeFileSync(file + ".tmp", JSON.stringify(value, null, 2));
    fs.renameSync(file + ".tmp", file);
  }

  /** Notes keyed by 1-based page number. */
  const readNotes = (pdf) => readSidecar(notesPath(inLibrary(pdf)), "notes") ?? {};

  function saveNotes(pdf, notes) {
    const kept = Object.fromEntries(Object.entries(notes).filter(([, text]) => text));
    writeSidecar(notesPath(inLibrary(pdf)), Object.keys(kept).length ? kept : null);
  }

  /** Highlights and page notes hold 1-based pages; positions are fractions of the page. Highlight rects are [x, y, width, height]. */
  const readAnnotations = (pdf) =>
    readSidecar(annotationsPath(inLibrary(pdf)), "annotations") ?? { highlights: [], pageNotes: [] };

  function saveAnnotations(pdf, annotations) {
    if (!Array.isArray(annotations?.highlights)) throw new Error("Annotations must hold a list of highlights.");
    const empty = !annotations.highlights.length && !annotations.pageNotes?.length;
    writeSidecar(annotationsPath(inLibrary(pdf)), empty ? null : annotations);
  }

  async function readPosition(pdf) {
    const value = await fs.promises.readFile(positionPath(inLibrary(pdf)), "utf8").catch(() => null);
    try {
      return value && JSON.parse(value);
    } catch {
      return null;
    }
  }

  // Losing a reading position is harmless, so write failures are ignored.
  async function savePosition(pdf, position) {
    await fs.promises.writeFile(positionPath(inLibrary(pdf)), JSON.stringify(position)).catch(() => {});
  }

  /** Keeps a copy of a PDF's contents under `versionsPath` for undo and returns its id. */
  async function keepVersion(bytes) {
    await fs.promises.mkdir(versionsPath, { recursive: true });
    const id = crypto.randomUUID() + ".pdf";
    await fs.promises.writeFile(path.join(versionsPath, id), bytes);
    return id;
  }

  /** Puts back a version kept by `editPage`. Notes and annotations are the caller's to restore. */
  async function restoreVersion(pdf, id) {
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
   * Returns the ids of the versions before and after, for `restoreVersion`.
   */
  async function editPage(pdf, { action, page, rotate }) {
    pdf = inLibrary(pdf);
    // Unreadable sidecars throw here, before anything changes.
    const notes = readNotes(pdf);
    const annotations = readAnnotations(pdf);
    const position = await readPosition(pdf);

    const original = await fs.promises.readFile(pdf);
    let doc;
    try {
      doc = await PDFDocument.load(original);
    } catch {
      throw new Error("The pages of this PDF can't be edited because it is encrypted or damaged.");
    }
    const count = doc.getPageCount();
    if (!Number.isInteger(page) || page < 1 || page > count) throw new Error("That page doesn't exist.");
    const index = page - 1;
    /** Where an old page number ends up, or null once deleted. */
    let moved = (p) => p;
    let turn = null;
    if (action === "insertBlank" || action === "duplicate") {
      const source = doc.getPage(index);
      if (action === "duplicate") doc.insertPage(page, (await doc.copyPages(doc, [index]))[0]);
      else doc.insertPage(page, [source.getWidth(), source.getHeight()]).setRotation(source.getRotation());
      moved = (p) => (p > page ? p + 1 : p);
    } else if (action === "delete") {
      if (count === 1) throw new Error("A PDF needs at least one page.");
      doc.removePage(index);
      moved = (p) => (p === page ? null : p > page ? p - 1 : p);
    } else if (action === "rotate" && (rotate === 90 || rotate === -90)) {
      const target = doc.getPage(index);
      target.setRotation(degrees((target.getRotation().angle + rotate + 360) % 360));
      turn = rotate;
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

    const follow = (items = []) =>
      items.flatMap((item) => {
        const to = moved(item.page);
        if (!to) return [];
        if (!turn || to !== page) return [{ ...item, page: to }];
        if (item.rects) return [{ ...item, rects: item.rects.map((rect) => turnRect(rect, turn)) }];
        // shortcut: only the note's anchor corner turns, so a note may shift by its own size; fine for short notes.
        const [x, y] = turnRect([item.x, item.y, 0, 0], turn);
        return [{ ...item, x, y }];
      });
    saveNotes(
      pdf,
      Object.fromEntries(Object.entries(notes).flatMap(([p, text]) => (moved(Number(p)) ? [[moved(Number(p)), text]] : []))),
    );
    saveAnnotations(pdf, {
      ...annotations,
      highlights: follow(annotations.highlights),
      pageNotes: follow(annotations.pageNotes),
    });
    // Positions are 0-based; a deleted current page gives way to the one after it.
    if (position?.page != null) {
      await savePosition(pdf, { ...position, page: (moved(position.page + 1) ?? Math.min(page, count - 1)) - 1 });
    }
    return versions;
  }

  return {
    root,
    inLibrary,
    listLibrary,
    createFolder,
    importPDF,
    renamePDF,
    trashPDF,
    readPDF: (pdf) => fs.promises.readFile(inLibrary(pdf)),
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

module.exports = { createLibrary };
