// Writes a sample library for development: PDFs with notes, highlights and text boxes, markdown files and decks.
// Usage: node scripts/seed.ts [libraryPath]; replaces whatever is at libraryPath.
import fs from "node:fs";
import path from "node:path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { Annotations, Deck, Notes, Position } from "../electron/library.ts";

export const devLibrary = path.resolve(import.meta.dirname, "../.dev-data/Library");

const lorem =
  "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.";

interface PageSpec {
  title: string;
  size?: [number, number];
}

/** Each page gets its title and wrapped paragraphs; returns the PDF and, per page, the title's rect as page fractions. */
async function makePDF(pages: PageSpec[]) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const titleRects: [number, number, number, number][] = [];
  for (const [index, spec] of pages.entries()) {
    const [width, height] = spec.size ?? [612, 792];
    const page = doc.addPage([width, height]);
    const titleSize = 22;
    const titleTop = 72;
    page.drawText(spec.title, { x: 72, y: height - titleTop - titleSize, size: titleSize, font: bold });
    titleRects.push([
      72 / width,
      (titleTop - 4) / height,
      (bold.widthOfTextAtSize(spec.title, titleSize) + 4) / width,
      (titleSize + 8) / height,
    ]);
    let y = height - titleTop - titleSize - 36;
    while (y > 90) {
      page.drawText(lorem, { x: 72, y, size: 11, font, lineHeight: 15, maxWidth: width - 144 });
      y -= 15 * Math.ceil(font.widthOfTextAtSize(lorem, 11) / (width - 144)) + 18;
    }
    page.drawText(`${index + 1} / ${pages.length}`, { x: width / 2 - 12, y: 36, size: 9, font, color: rgb(0.5, 0.5, 0.5) });
  }
  return { bytes: await doc.save(), titleRects };
}

const json = (value: unknown) => JSON.stringify(value, null, 2);

export async function seed(root: string) {
  fs.rmSync(root, { recursive: true, force: true });
  const write = (file: string, data: string | Uint8Array) => {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
  };

  // A long paper with every kind of sidecar.
  const paper = await makePDF(Array.from({ length: 40 }, (_, i) => ({ title: `Section ${i + 1}` })));
  write("Papers/Attention Is All You Need.pdf", paper.bytes);
  write(
    "Papers/Attention Is All You Need.notes.json",
    json({ "1": "Read the abstract twice.", "3": "Key idea: **self-attention** replaces recurrence.\n\n- compare with RNNs\n- check the complexity table" } satisfies Notes),
  );
  write(
    "Papers/Attention Is All You Need.annotations.json",
    json({
      highlights: [
        { id: "h1", page: 1, color: "#fde047", rects: [paper.titleRects[0]] },
        { id: "h2", page: 2, color: "#86efac", rects: [paper.titleRects[1], [0.12, 0.2, 0.7, 0.02]] },
        { id: "h3", page: 5, color: "#f9a8d4", rects: [paper.titleRects[4]] },
      ],
      pageNotes: [
        { id: "n1", page: 1, x: 0.55, y: 0.06, w: 200, h: 60, text: "Start here", size: 18, bold: true, color: "#dc2626" },
        { id: "n2", page: 2, x: 0.1, y: 0.8, text: "A plain text box", italic: true, underline: true },
      ],
    } satisfies Annotations),
  );
  write("Papers/Attention Is All You Need.position.json", json({ page: 2, scale: 1.25 } satisfies Position));
  write("Papers/Short Note.pdf", (await makePDF([{ title: "A single page" }])).bytes);
  write(
    "Papers/Mixed Page Sizes.pdf",
    (
      await makePDF([
        { title: "Letter portrait" },
        { title: "A4 landscape", size: [842, 595] },
        { title: "A5", size: [420, 595] },
        { title: "Tall receipt", size: [300, 1200] },
      ])
    ).bytes,
  );

  write("Books/Ünïcödé — names & spaces (2nd ed.).pdf", (await makePDF([{ title: "Ünïcödé" }, { title: "Page two" }])).bytes);
  write("Books/Big Book.pdf", (await makePDF(Array.from({ length: 300 }, (_, i) => ({ title: `Chapter ${i + 1}` })))).bytes);

  write(
    "Notes/Reading List.md",
    "# Reading list\n\n- [x] Attention Is All You Need\n- [ ] Big Book\n\n## Quotes\n\n> The best code is no code.\n\n```ts\nconst answer = 42;\n```\n",
  );
  write("Notes/Empty.md", "");
  write(
    "Notes/Spanish.cards",
    json({
      cards: [
        { id: "c1", front: "hola", back: "hello" },
        { id: "c2", front: "**gracias**", back: "thank you" },
        { id: "c3", front: "¿Dónde está la biblioteca?", back: "Where is the library?\n\n- *dónde*: where\n- *biblioteca*: library" },
      ],
    } satisfies Deck),
  );
  write("Notes/Empty Deck.cards", json({ cards: [] } satisfies Deck));
  write(
    "Notes/Spanish.quiz",
    json({
      questions: [
        { type: "choice", prompt: "What does **gracias** mean?", choices: ["Please", "Thank you", "Sorry"], answer: 1 },
        { type: "choice", prompt: "Which of these are greetings?", choices: ["Hola", "Adiós", "Buenos días"], answer: [0, 2], explanation: "*Adiós* means goodbye." },
        { type: "truefalse", prompt: "*El gato* means the dog.", answer: false, explanation: "It means the cat; the dog is *el perro*." },
        { type: "blank", prompt: "The Spanish word for water is ___.", answer: ["agua", "el agua"] },
      ],
    }),
  );

  // HTML pages and their assets are real files, so they can be edited and opened in a browser too.
  fs.cpSync(path.join(import.meta.dirname, "fixtures/Web"), path.join(root, "Web"), { recursive: true });

  fs.mkdirSync(path.join(root, "Empty Folder"), { recursive: true });
}

if (import.meta.main) {
  const root = path.resolve(process.argv[2] ?? devLibrary);
  await seed(root);
  console.log(`Seeded ${root}`);
}
