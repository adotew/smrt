const fs = require("node:fs");
const path = require("node:path");

/** Folders of PDFs under `libraryPath`, each with optional sidecar files next to it. */
function createLibrary(libraryPath, { trash }) {
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
  };
}

module.exports = { createLibrary };
