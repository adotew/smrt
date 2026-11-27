import assert from "node:assert/strict";
import test from "node:test";
import { findMatches, locate, pageText } from "./find.ts";

const page = pageText([
  { str: "The Quick", hasEOL: true },
  { type: "beginMarkedContent" },
  { str: "brown fox", hasEOL: false },
  { str: " jumps", hasEOL: false },
]);

test("a page's text joins its items, with a space after each line", () => {
  assert.equal(page.text, "the quick brown fox jumps");
  assert.deepEqual(page.starts, [0, 10, 19]);
});

test("matches ignore case and span lines and items", () => {
  assert.deepEqual(findMatches([page, page], "QUICK BROWN"), [
    { page: 0, start: 4, end: 15 },
    { page: 1, start: 4, end: 15 },
  ]);
  assert.deepEqual(
    findMatches([page], "o").map((m) => m.start),
    [12, 17],
  );
  assert.deepEqual(findMatches([page], "  "), []);
});

test("offsets map back to the item that holds them", () => {
  assert.deepEqual(locate(page, 4), [0, 4]);
  assert.deepEqual(locate(page, 10), [1, 0]);
  assert.deepEqual(locate(page, 9), null);
  assert.deepEqual(locate(page, 9, true), [0, 9]);
  assert.deepEqual(locate(page, 25, true), [2, 6]);
});
