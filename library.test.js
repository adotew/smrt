const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createLibrary } = require("./library");

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "macpdf-"));
  const trashed = [];
  const library = createLibrary(path.join(dir, "library"), { trash: async (file) => trashed.push(file) });
  const source = path.join(dir, "Paper.pdf");
  fs.writeFileSync(source, "%PDF-1.4\n%%EOF\n");
  return { dir, library, source, trashed };
}

test("folders persist and names are validated", () => {
  const { library } = setup();
  library.createFolder("  Math ");
  assert.deepEqual(library.listLibrary().map((f) => f.name), ["Math"]);
  assert.throws(() => library.createFolder("Math"), /already exists/);
  for (const name of ["", "..", "a/b", "a:b"]) assert.throws(() => library.createFolder(name), /without slashes/);
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
