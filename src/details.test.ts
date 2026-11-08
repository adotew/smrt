import assert from "node:assert/strict";
import test from "node:test";
import { MarkdownManager } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";
import { Details, DetailsContent, DetailsSummary } from "./details.ts";

test("toggles, nested ones too, round-trip as <details>", () => {
  const markdown = new MarkdownManager({ extensions: [StarterKit, Details, DetailsSummary, DetailsContent] });
  const source = [
    "<details>\n<summary>Toggle **bold**</summary>",
    "inside\n\n- a",
    "<details open>\n<summary>nested</summary>",
    "deep",
    "</details>",
    "</details>",
    "after",
  ].join("\n\n");
  const doc = markdown.parse(source);
  assert.equal(doc.content?.[0]?.type, "details");
  assert.equal(markdown.serialize(doc), source);
});
