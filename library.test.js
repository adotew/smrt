const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createLibrary } = require("./library");

function setup(options) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smrt-"));
  const trashed = [];
  const library = createLibrary(path.join(dir, "library"), { trash: async (file) => trashed.push(file), ...options });
  const source = path.join(dir, "Paper.pdf");
  fs.writeFileSync(source, "%PDF-1.4\n%%EOF\n");
  return { dir, library, source, trashed };
}

test("folders persist and names are validated", () => {
  const { library } = setup();
  library.createFolder("  Math ");
  assert.deepEqual(library.listLibrary().map((f) => f.name), ["Math"]);
  assert.throws(() => library.createFolder("Math"), /already exists/);
  for (const name of ["", "..", "a/b", "a:b", "a\\b", "a?b", "a|b"]) {
    assert.throws(() => library.createFolder(name), /without any of these characters/);
  }
});

test("importing refuses invalid PDFs and duplicates", () => {
  const { dir, library, source } = setup();
  const folder = library.createFolder("Math");
  const imported = library.importPDF(source, folder);
  assert.equal(fs.readFileSync(imported, "utf8"), fs.readFileSync(source, "utf8"));
  assert.throws(() => library.importPDF(source, folder), /already in this folder/);
  const fake = path.join(dir, "fake.pdf");
  fs.writeFileSync(fake, "not a pdf");
  assert.throws(() => library.importPDF(fake, folder), /could not be opened/);
  assert.throws(() => library.importPDF(source, dir), /outside the library/);
});

test("renaming and trashing keep notes with their PDF", async () => {
  const { library, source, trashed } = setup();
  const folder = library.createFolder("Math");
  const pdf = library.importPDF(source, folder);
  library.saveNotes(pdf, { 1: "first", 2: "" });
  const renamed = library.renamePDF(pdf, "Lecture 1.pdf");
  assert.equal(path.basename(renamed), "Lecture 1.pdf");
  assert.deepEqual(library.readNotes(renamed), { 1: "first" });
  assert.equal(library.renamePDF(renamed, "lecture 1"), path.join(folder, "lecture 1.pdf"));

  library.importPDF(source, folder);
  assert.throws(() => library.renamePDF(path.join(folder, "Paper.pdf"), "lecture 1"), /already exists/);

  await library.trashPDF(path.join(folder, "lecture 1.pdf"));
  assert.deepEqual(trashed.map((f) => path.basename(f)), ["lecture 1.pdf", "lecture 1.notes.json"]);
});

test("empty notes remove the file and reading positions round-trip", async () => {
  const { library, source } = setup();
  const pdf = library.importPDF(source, library.createFolder("Math"));
  library.saveNotes(pdf, { 1: "x" });
  library.saveNotes(pdf, { 1: "" });
  assert.equal(fs.existsSync(pdf.replace(/\.pdf$/, ".notes.json")), false);
  assert.equal(await library.readPosition(pdf), null);
  await library.savePosition(pdf, { page: 3, scale: 1.5 });
  assert.deepEqual(await library.readPosition(pdf), { page: 3, scale: 1.5 });
});

test("annotations round-trip, follow renames and vanish when empty", () => {
  const { library, source } = setup();
  const pdf = library.importPDF(source, library.createFolder("Math"));
  assert.deepEqual(library.readAnnotations(pdf), { highlights: [] });
  const annotations = { highlights: [{ id: "a", page: 1, color: "yellow", rects: [[0.1, 0.2, 0.3, 0.02]] }] };
  library.saveAnnotations(pdf, annotations);
  const renamed = library.renamePDF(pdf, "Lecture");
  assert.deepEqual(library.readAnnotations(renamed), annotations);
  assert.throws(() => library.saveAnnotations(renamed, {}), /list of highlights/);
  library.saveAnnotations(renamed, { highlights: [] });
  assert.equal(fs.existsSync(renamed.replace(/\.pdf$/, ".annotations.json")), false);
});

test("without xattrs, positions use a sidecar that follows the PDF", async () => {
  const { library, source, trashed } = setup({ xattrPositions: false });
  const pdf = library.importPDF(source, library.createFolder("Math"));
  assert.equal(await library.readPosition(pdf), null);
  await library.savePosition(pdf, { page: 2 });
  assert.ok(fs.existsSync(pdf.replace(/\.pdf$/, ".position.json")));
  assert.deepEqual(library.listLibrary()[0].pdfs.map((p) => p.name), ["Paper.pdf"]);

  const renamed = library.renamePDF(pdf, "Lecture");
  assert.deepEqual(await library.readPosition(renamed), { page: 2 });
  await library.trashPDF(renamed);
  assert.deepEqual(trashed.map((f) => path.basename(f)), ["Lecture.pdf", "Lecture.position.json"]);
});
