import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import assert from "node:assert/strict";
import test from "node:test";
import { createConverter } from "./assistant.ts";

const base = { parent_tool_use_id: null, uuid: "u", session_id: "s" };
const event = (event: object) => ({ type: "stream_event", event, ...base }) as unknown as SDKMessage;

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
