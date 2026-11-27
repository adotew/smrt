/** A page's text as pdf.js's text layer lays it out: one string per span. */
export interface PageText {
  items: string[];
  /** Where each item starts in `text`. */
  starts: number[];
  /** The items joined and lower-cased, with a space after each line so words on adjacent lines stay apart. */
  text: string;
}

/** A match's place in its page's `text`; `page` counts from 0. */
export interface Match {
  page: number;
  start: number;
  end: number;
}

// Lower-casing a few characters, like İ, changes their length, which would misplace every later match.
const fold = (text: string) => {
  const lower = text.toLowerCase();
  return lower.length === text.length ? lower : text;
};

/** Takes the items of `getTextContent()`, which match the text layer's spans one for one. */
export function pageText(items: readonly object[]): PageText {
  const page: PageText = { items: [], starts: [], text: "" };
  for (const item of items) {
    if (!("str" in item) || typeof item.str !== "string") continue;
    page.items.push(item.str);
    page.starts.push(page.text.length);
    page.text += fold(item.str);
    if ("hasEOL" in item && item.hasEOL) page.text += " ";
  }
  return page;
}

export function findMatches(pages: PageText[], query: string): Match[] {
  const needle = fold(query);
  if (!needle.trim()) return [];
  return pages.flatMap(({ text }, page) => {
    const matches: Match[] = [];
    for (let start = text.indexOf(needle); start >= 0; start = text.indexOf(needle, start + needle.length)) {
      matches.push({ page, start, end: start + needle.length });
    }
    return matches;
  });
}

/** The item holding `offset` in `page.text`, and the offset within it; `end` places an offset just past an item in that item. */
export function locate(page: PageText, offset: number, end = false): [item: number, offset: number] | null {
  for (let i = 0; i < page.items.length; i++) {
    const from = page.starts[i];
    const to = from + page.items[i].length;
    if (end ? offset > from && offset <= to : offset >= from && offset < to) return [i, offset - from];
  }
  return null;
}

/** The text layer range `match` covers, given the layer's spans; null if it lies on the spaces between lines. */
export function matchRange(page: PageText, spans: readonly HTMLElement[], match: Match): Range | null {
  let start = locate(page, match.start);
  const end = locate(page, match.end, true);
  // A match may begin on the space after a line, which belongs to no span.
  if (!start) {
    const next = page.starts.findIndex((from) => from > match.start);
    start = next >= 0 ? [next, 0] : null;
  }
  const startNode = start && spans[start[0]]?.firstChild;
  const endNode = end && spans[end[0]]?.firstChild;
  if (!start || !end || !startNode || !endNode) return null;
  const range = document.createRange();
  range.setStart(startNode, start[1]);
  range.setEnd(endNode, end[1]);
  return range.collapsed ? null : range;
}
