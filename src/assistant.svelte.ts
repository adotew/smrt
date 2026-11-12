import { Chat } from "@ai-sdk/svelte";
import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";
import type { Folder } from "../electron/library.ts";

// Pinned rather than Claude Code's aliases, so the label names the version that answers.
export const models = [
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5", icon: "claude" as const },
  { id: "claude-opus-5-5", label: "Opus 5.5", icon: "claude" as const },
  { id: "claude-haiku-5-5", label: "Haiku 5.5", icon: "claude" as const },
];

/** Shared by every place the assistant shows up, so the conversation follows the person around. */
export const assistant = $state({
  model: models[0].id,
  /** The file the next message is about. */
  context: null as string | null,
  library: [] as Folder[],
  /** How many times the assistant has written each file, so open copies reload. */
  edits: {} as Record<string, number>,
});

const api = window.smrt;
const textOf = (message: UIMessage | undefined) =>
  message?.parts.map((part) => (part.type === "text" ? part.text : "")).join("") ?? "";

/** The stream the main process is writing to; its chunks arrive on one channel. */
let current: ReadableStreamDefaultController<UIMessageChunk> | null = null;
api.on("assistant", (chunk) => {
  if (!current) return;
  if (chunk.type === "tool-output-available") {
    // Every file tool reports its path, so this counts writes once the reply's tool calls are known.
    const part = chat.lastMessage?.parts.find((p) => "toolCallId" in p && p.toolCallId === chunk.toolCallId);
    const file = part && "input" in part ? (part.input as { file_path?: string } | undefined)?.file_path : undefined;
    if (file && part && /^tool-(Write|Edit)$/.test(part.type)) assistant.edits[file] = (assistant.edits[file] ?? 0) + 1;
  }
  current.enqueue(chunk);
  if (chunk.type === "finish") {
    current.close();
    current = null;
  }
});

function listen(abortSignal: AbortSignal | undefined, resumed?: string) {
  current?.close();
  let own: typeof current = null;
  const stream = new ReadableStream<UIMessageChunk>({ start: (controller) => void (current = own = controller) });
  abortSignal?.addEventListener("abort", () => {
    api.stopAssistant();
    if (current === own) current = null;
  });
  // A reply resumed after an approval continues the message that asked.
  if (!resumed) return stream;
  return stream.pipeThrough(
    new TransformStream<UIMessageChunk, UIMessageChunk>({
      transform: (chunk, controller) => controller.enqueue(chunk.type === "start" ? { ...chunk, messageId: resumed } : chunk),
    }),
  );
}

const transport: ChatTransport<UIMessage> = {
  async sendMessages({ messages, abortSignal }) {
    const last = messages.at(-1);
    if (last?.role === "assistant") {
      const stream = listen(abortSignal, last.id);
      for (const part of last.parts) {
        if ("approval" in part && part.state === "approval-responded") await api.answerAssistant(part.approval.id, part.approval.approved);
      }
      return stream;
    }
    const stream = listen(abortSignal);
    await api.askAssistant({
      text: textOf(last),
      context: assistant.context,
      model: assistant.model,
      fresh: messages.filter((m) => m.role === "user").length === 1,
    });
    return stream;
  },
  reconnectToStream: async () => null,
};

export const chat = new Chat({
  transport,
  sendAutomaticallyWhen: ({ messages }) =>
    messages.at(-1)?.parts.some((p) => "approval" in p && p.state === "approval-responded") ?? false,
});
