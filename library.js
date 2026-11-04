const { execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

// Shared with the Swift app so both read the same reading positions.
const positionAttribute = "dev.macpdf.reading-position";

/** Folders of PDFs under `libraryPath`, mirroring the Swift app's Library. */
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
    if (!name || name === "." || name === ".." || /[/:\0]/.test(name)) {
      throw new Error("Enter a name without slashes or colons.");
    }
    return name;
  }

  const notesPath = (pdf) => pdf.replace(/\.pdf$/i, ".notes.json");

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
    if (fs.existsSync(notesPath(pdf))) {
      try {
        fs.renameSync(notesPath(pdf), notesPath(destination));
      } catch (error) {
        // Keep the PDF and its notes together.
        fs.renameSync(destination, pdf);
        throw error;
      }
    }
    return destination;
  }

  async function trashPDF(pdf) {
    pdf = inLibrary(pdf);
    await trash(pdf);
    if (fs.existsSync(notesPath(pdf))) await trash(notesPath(pdf));
  }

  /** Notes keyed by 1-based page number. Unreadable notes throw so the renderer never overwrites them. */
  function readNotes(pdf) {
    const file = notesPath(inLibrary(pdf));
    if (!fs.existsSync(file)) return {};
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      throw new Error(`The notes in “${path.basename(file)}” could not be read.`);
    }
  }

  function saveNotes(pdf, notes) {
    const file = notesPath(inLibrary(pdf));
    const kept = Object.fromEntries(Object.entries(notes).filter(([, text]) => text));
    if (Object.keys(kept).length === 0) {
      fs.rmSync(file, { force: true });
      return;
    }
    fs.writeFileSync(file + ".tmp", JSON.stringify(kept, null, 2));
    fs.renameSync(file + ".tmp", file);
  }

  const xattr = (...args) =>
    new Promise((resolve) => execFile("/usr/bin/xattr", args, (error, stdout) => resolve(error ? null : stdout)));

  async function readPosition(pdf) {
    const value = await xattr("-p", positionAttribute, inLibrary(pdf));
    try {
      return value && JSON.parse(value);
    } catch {
      return null;
    }
  }

  // Losing a reading position is harmless, so write failures are ignored.
  const savePosition = (pdf, position) => xattr("-w", positionAttribute, JSON.stringify(position), inLibrary(pdf));

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
    readPosition,
    savePosition,
  };
}

module.exports = { createLibrary };
