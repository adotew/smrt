import type { CanUseTool, Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { UIMessageChunk } from "ai";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAssistant, createConverter } from "./assistant.ts";

const base = { parent_tool_use_id: null, uuid: "u", session_id: "s" };
const event = (event: object) => ({ type: "stream_event", event, ...base }) as unknown as SDKMessage;
const toolUse = (tools: { id: string; name: string; input: Record<string, unknown> }[]) =>
  ({ type: "assistant", message: { content: tools.map((t) => ({ type: "tool_use", ...t })) }, ...base }) as unknown as SDKMessage;
const toolResult = (results: { tool_use_id: string; content: string; is_error?: boolean }[]) =>
  ({ type: "user", message: { role: "user", content: results.map((r) => ({ type: "tool_result", ...r })) }, ...base }) as unknown as SDKMessage;

test("streamed text and thinking become text and reasoning parts", () => {
  const { convert } = createConverter(() => false);
  const chunks = [
    event({ type: "message_start" }),
    event({ type: "content_block_start", index: 0, content_block: { type: "thinking" } }),
    event({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Hmm" } }),
    event({ type: "content_block_stop", index: 0 }),
    event({ type: "content_block_start", index: 1, content_block: { type: "text" } }),
    event({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hi" } }),
    event({ type: "content_block_stop", index: 1 }),
  ].flatMap(convert);
  assert.deepEqual(chunks, [
    { type: "reasoning-start", id: "0" },
    { type: "reasoning-delta", id: "0", delta: "Hmm" },
    { type: "reasoning-end", id: "0" },
    { type: "text-start", id: "1" },
    { type: "text-delta", id: "1", delta: "Hi" },
    { type: "text-end", id: "1" },
  ]);
});

test("tool calls get titles, and denied ones stay denied", () => {
  const converter = createConverter((file) => file === "/lib/A/Old.md");
  const assistant = (name: string, id: string, file_path: string) =>
    ({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input: { file_path } }] }, ...base }) as unknown as SDKMessage;
  const titles = [
    assistant("Write", "1", "/lib/A/New.cards"),
    assistant("Write", "2", "/lib/A/Old.md"),
    assistant("Read", "3", "/lib/A/Paper.pdf"),
  ]
    .flatMap(converter.convert)
    .map((chunk) => "title" in chunk && chunk.title);
  assert.deepEqual(titles, ["Create New.cards", "Edit Old.md", "Read Paper.pdf"]);
  assert.ok(converter.shown("2"));

  converter.deny("2");
  const results = converter.convert({
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "1", content: "ok" },
        { type: "tool_result", tool_use_id: "2", content: "declined", is_error: true },
        { type: "tool_result", tool_use_id: "3", content: [{ type: "text", text: "Too big" }], is_error: true },
      ],
    },
    ...base,
  } as SDKMessage);
  assert.deepEqual(results, [
    { type: "tool-output-available", toolCallId: "1", output: null, providerExecuted: true },
    { type: "tool-output-denied", toolCallId: "2" },
    { type: "tool-output-error", toolCallId: "3", errorText: "Too big", providerExecuted: true },
  ]);
});

test("a signed-out run asks the person to sign in", () => {
  const { convert } = createConverter(() => false);
  convert({ type: "assistant", error: "authentication_failed", message: { content: [] }, ...base } as unknown as SDKMessage);
  const [chunk] = convert({ type: "result", subtype: "success", is_error: true, result: "Not logged in", ...base } as unknown as SDKMessage);
  assert.deepEqual(chunk, { type: "error", errorText: "Sign in to Claude in Settings to use the assistant." });
});

function setupAssistant(handler: (canUseTool: CanUseTool, signal: AbortSignal) => AsyncGenerator<SDKMessage>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smrt-assistant-"));
  const lib = path.join(dir, "library");
  fs.mkdirSync(path.join(lib, "Math"), { recursive: true });
  const chunks: UIMessageChunk[] = [];
  const fakeRun = (({ options }: { options?: Options }) =>
    handler(options!.canUseTool!, options!.abortController!.signal)) as unknown as NonNullable<Parameters<typeof createAssistant>[3]>;
  const assistant = createAssistant(lib, "", (chunk) => chunks.push(chunk), fakeRun);
  return { dir: fs.realpathSync(dir), lib: fs.realpathSync(lib), chunks, assistant };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 10));

test("canUseTool enforces library boundary, symlinks, globs and write extensions", async () => {
  let check!: CanUseTool;
  let signal!: AbortSignal;
  const { dir, lib, assistant } = setupAssistant(async function* (canUseTool, abortSignal) {
    check = canUseTool;
    signal = abortSignal;
  });
  const outside = path.join(dir, "secret.md");
  fs.writeFileSync(outside, "secret");
  const symlink = path.join(lib, "Math", "escape.md");
  const dangling = path.join(lib, "Math", "dangling.md");
  fs.symlinkSync(outside, symlink);
  fs.symlinkSync(path.join(dir, "new-outside.md"), dangling);

  assistant.ask({ text: "hi", context: null, model: "m", fresh: true });
  await flush();

  const call = (tool: string, input: Record<string, unknown>, id = "t") => check(tool, input, { signal, toolUseID: id, requestId: id });
  assert.equal((await call("Read", { file_path: outside }))?.behavior, "deny");
  assert.equal((await call("Read", { file_path: "../secret.md" }))?.behavior, "deny");
  assert.equal((await call("Read", { file_path: symlink }))?.behavior, "deny");
  assert.equal((await call("Write", { file_path: dangling }))?.behavior, "deny");
  assert.equal((await call("Glob", { pattern: "../**/*.md" }))?.behavior, "deny");
  assert.equal((await call("Grep", { glob: "../*.md", pattern: "x" }))?.behavior, "deny");
  assert.equal((await call("Grep", { pattern: "\\.\\./" }))?.behavior, "allow");
  assert.equal((await call("Write", { file_path: "Math/..notes.md" }))?.behavior, "allow");
  assert.equal((await call("Write", { file_path: "Math/Paper.notes.json" }))?.behavior, "deny");
  assert.equal((await call("Edit", { file_path: "Math/run.sh" }))?.behavior, "deny");
  assert.equal((await call("Write", { file_path: "Math/New.md" }))?.behavior, "allow");
});

test("multiple edits in one turn ask for approval one at a time and resolve relative paths", async () => {
  let decisions: (string | undefined)[] = [];
  const { lib, chunks, assistant } = setupAssistant(async function* (canUseTool, signal) {
    yield toolUse([
      { id: "e1", name: "Edit", input: { file_path: "Math/A.md" } },
      { id: "e2", name: "Edit", input: { file_path: "Math/B.md" } },
    ]);
    const [r1, r2] = await Promise.all([
      canUseTool("Edit", { file_path: "Math/A.md" }, { signal, toolUseID: "e1", requestId: "e1" }),
      canUseTool("Edit", { file_path: "Math/B.md" }, { signal, toolUseID: "e2", requestId: "e2" }),
    ]);
    decisions = [r1?.behavior, r2?.behavior];
    yield toolResult([
      { tool_use_id: "e1", content: "ok" },
      { tool_use_id: "e2", content: "declined", is_error: true },
    ]);
  });
  fs.writeFileSync(path.join(lib, "Math", "A.md"), "a");
  fs.writeFileSync(path.join(lib, "Math", "B.md"), "b");

  assistant.ask({ text: "edit both", context: null, model: "m", fresh: true });
  await flush();

  // Relative file_path values are normalized to absolute paths for the renderer.
  const inputs = chunks.filter((c) => c.type === "tool-input-available");
  assert.deepEqual(
    inputs.map((c) => (c.input as { file_path: string }).file_path),
    [path.join(lib, "Math", "A.md"), path.join(lib, "Math", "B.md")],
  );
  // Only the first approval is requested before the person answers.
  assert.deepEqual(
    chunks.filter((c) => c.type === "tool-approval-request").map((c) => c.approvalId),
    ["e1"],
  );

  assistant.answer("e1", true);
  await flush();
  // Answering the first queues the second approval request.
  assert.deepEqual(
    chunks.filter((c) => c.type === "tool-approval-request").map((c) => c.approvalId),
    ["e1", "e2"],
  );

  assistant.answer("e2", false);
  await flush();
  assert.deepEqual(decisions, ["allow", "deny"]);
  assert.ok(chunks.some((c) => c.type === "tool-output-available" && c.toolCallId === "e1"));
  assert.ok(chunks.some((c) => c.type === "tool-output-denied" && c.toolCallId === "e2"));
  assert.equal(chunks.at(-1)?.type, "finish");
});

test("stop settles pending approvals instead of hanging", async () => {
  let result: string | undefined;
  const { lib, assistant } = setupAssistant(async function* (canUseTool, signal) {
    yield toolUse([{ id: "e1", name: "Edit", input: { file_path: "Math/A.md" } }]);
    const decision = await canUseTool("Edit", { file_path: "Math/A.md" }, { signal, toolUseID: "e1", requestId: "e1" });
    result = decision?.behavior;
  });
  fs.writeFileSync(path.join(lib, "Math", "A.md"), "a");

  assistant.ask({ text: "edit", context: null, model: "m", fresh: true });
  await flush();
  assistant.stop();
  await flush();
  assert.equal(result, "deny");
});
