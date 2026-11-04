import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PDFDocument } from "pdf-lib";
import { createLibrary } from "./library.ts";
import type { Annotations } from "./library.ts";

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smrt-"));
  const trashed: string[] = [];
  const library = createLibrary(path.join(dir, "library"), {
    trash: async (file) => trashed.push(file),
    versionsPath: path.join(dir, "versions"),
  });
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
  assert.deepEqual(library.readAnnotations(pdf), { highlights: [], pageNotes: [] });
  const annotations: Annotations = {
    highlights: [{ id: "a", page: 1, color: "yellow", rects: [[0.1, 0.2, 0.3, 0.02]] }],
    pageNotes: [{ id: "b", page: 1, x: 0.5, y: 0.5, text: "hi" }],
  };
  library.saveAnnotations(pdf, annotations);
  const renamed = library.renamePDF(pdf, "Lecture");
  assert.deepEqual(library.readAnnotations(renamed), annotations);
  assert.throws(() => library.saveAnnotations(renamed, {} as never), /list of highlights/);
  library.saveAnnotations(renamed, { highlights: [], pageNotes: [] });
  assert.equal(fs.existsSync(renamed.replace(/\.pdf$/, ".annotations.json")), false);
});

test("positions use a sidecar that follows the PDF", async () => {
  const { library, source, trashed } = setup();
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

test("page edits keep sidecars on their pages and trash the original", async () => {
  const { dir, library, trashed } = setup();
  const doc = await PDFDocument.create();
  for (const width of [100, 200, 300]) doc.addPage([width, 400]);
  const source = path.join(dir, "Three.pdf");
  fs.writeFileSync(source, await doc.save());
  const pdf = library.importPDF(source, library.createFolder("Math"));
  const pages = async () =>
    (await PDFDocument.load(fs.readFileSync(pdf))).getPages().map((p) => [p.getWidth(), p.getRotation().angle]);

  library.saveNotes(pdf, { 1: "one", 2: "two", 3: "three" });
  library.saveAnnotations(pdf, {
    highlights: [{ id: "h", page: 2, color: "yellow", rects: [[0.1, 0.2, 0.3, 0.05]] }],
    pageNotes: [{ id: "n", page: 3, x: 0.25, y: 0.5, text: "hi" }],
  });
  await library.savePosition(pdf, { page: 2, scale: 1.5 });

  await library.editPage(pdf, { action: "duplicate", page: 1 });
  assert.deepEqual(await pages(), [[100, 0], [100, 0], [200, 0], [300, 0]]);
  assert.deepEqual(library.readNotes(pdf), { 1: "one", 3: "two", 4: "three" });
  assert.equal(library.readAnnotations(pdf).highlights[0].page, 3);
  assert.deepEqual(await library.readPosition(pdf), { page: 3, scale: 1.5 });

  await library.editPage(pdf, { action: "insertBlank", page: 4 });
  assert.deepEqual(await pages(), [[100, 0], [100, 0], [200, 0], [300, 0], [300, 0]]);

  await library.editPage(pdf, { action: "rotate", page: 3, rotate: 90 });
  assert.deepEqual((await pages())[2], [200, 90]);
  assert.deepEqual(library.readAnnotations(pdf).highlights[0].rects, [[0.75, 0.1, 0.05, 0.3]]);
  await library.editPage(pdf, { action: "rotate", page: 4, rotate: -90 });
  assert.deepEqual((await pages())[3], [300, 270]);
  assert.deepEqual(library.readAnnotations(pdf).pageNotes?.[0], { id: "n", page: 4, x: 0.5, y: 0.75, text: "hi" });

  await library.editPage(pdf, { action: "delete", page: 3 });
  assert.deepEqual(await pages(), [[100, 0], [100, 0], [300, 270], [300, 0]]);
  assert.deepEqual(library.readNotes(pdf), { 1: "one", 3: "three" });
  assert.deepEqual(library.readAnnotations(pdf).highlights, []);
  assert.deepEqual(await library.readPosition(pdf), { page: 2, scale: 1.5 });

  assert.equal(trashed.length, 5);
  assert.ok(trashed.every((file) => file === pdf));
  assert.equal(fs.existsSync(pdf + ".tmp"), false);
  await assert.rejects(library.editPage(pdf, { action: "delete", page: 9 }), /doesn't exist/);
  await assert.rejects(library.editPage(pdf, { action: "rotate", page: 1, rotate: 45 } as never), /Unknown page edit/);
});

test("the last page can't be deleted", async () => {
  const { dir, library } = setup();
  const doc = await PDFDocument.create();
  doc.addPage();
  const source = path.join(dir, "One.pdf");
  fs.writeFileSync(source, await doc.save());
  const pdf = library.importPDF(source, library.createFolder("Math"));
  await assert.rejects(library.editPage(pdf, { action: "delete", page: 1 }), /at least one page/);
});

test("page edits keep versions that can be restored", async () => {
  const { dir, library } = setup();
  const doc = await PDFDocument.create();
  doc.addPage();
  doc.addPage();
  const source = path.join(dir, "Two.pdf");
  fs.writeFileSync(source, await doc.save());
  const pdf = library.importPDF(source, library.createFolder("Math"));
  const count = async () => (await PDFDocument.load(fs.readFileSync(pdf))).getPageCount();

  const { before, after } = await library.editPage(pdf, { action: "delete", page: 1 });
  assert.equal(await count(), 1);
  await library.restoreVersion(pdf, before);
  assert.equal(await count(), 2);
  await library.restoreVersion(pdf, after);
  assert.equal(await count(), 1);
  for (const id of ["../Two.pdf", "a/b.pdf", "x.json", undefined]) {
    await assert.rejects(library.restoreVersion(pdf, id as string), /doesn't exist/);
  }
});
