import { query, type CanUseTool, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { UIMessageChunk } from "ai";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { realTarget } from "./library.ts";

export interface Ask {
  text: string;
  /** The file the person is looking at, if any. */
  context: string | null;
  model: string;
  /** Starts a new conversation instead of continuing the last one. */
  fresh: boolean;
}

export interface Account {
  loggedIn: boolean;
  email?: string;
  subscriptionType?: string;
}

const tools = ["Read", "Glob", "Grep", "Write", "Edit"];
const startTitles: Record<string, string> = { Read: "Reading", Write: "Writing", Edit: "Editing" };
const hasParentSegment = (value: unknown) => typeof value === "string" && /(^|[\\/])\.\.([\\/]|$)/.test(value);

// Claude Code prefers an API key over the subscription login; the assistant runs on the subscription.
const env = { ...process.env, ANTHROPIC_API_KEY: undefined };

// shortcut: names the glibc Linux package only; Alpine needs the -musl one.
const claude = () =>
  require
    .resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude${process.platform === "win32" ? ".exe" : ""}`)
    // Electron can't spawn a file inside app.asar, so the package script keeps the binary beside it.
    .replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);

/** Turns the Agent SDK's messages into the chunks the renderer's chat reads. */
export function createConverter(exists: (file: string) => boolean, resolveFile = (file: string) => file) {
  /** Open content blocks of the current model response, by index. */
  const blocks = new Map<number, { id: string; type: "text" | "reasoning" }>();
  const shown = new Set<string>();
  const denied = new Set<string>();
  let next = 0;
  let signedOut = false;

  function title(tool: string, input: Record<string, unknown>) {
    const name = path.basename(String(input.file_path ?? ""));
    if (tool === "Read") return `Read ${name}`;
    if (tool === "Write") return `${exists(String(input.file_path)) ? "Edit" : "Create"} ${name}`;
    if (tool === "Edit") return `Edit ${name}`;
    return "Searched the library";
  }

  function convert(message: SDKMessage): UIMessageChunk[] {
    if ("parent_tool_use_id" in message && message.parent_tool_use_id) return [];
    if (message.type === "stream_event") {
      const event = message.event;
      if (event.type === "message_start") blocks.clear();
      if (event.type === "content_block_start") {
        const block = event.content_block;
        if (block.type === "tool_use") {
          const toolCallId = block.id;
          return [{ type: "tool-input-start", toolCallId, toolName: block.name, title: startTitles[block.name] ?? "Searching the library", providerExecuted: true }];
        }
        const type = block.type === "text" ? "text" : block.type === "thinking" ? "reasoning" : null;
        if (!type) return [];
        const id = String(next++);
        blocks.set(event.index, { id, type });
        return [{ type: `${type}-start`, id }];
      }
      const block = blocks.get("index" in event ? event.index : -1);
      if (!block) return [];
      if (event.type === "content_block_delta") {
        if (event.delta.type === "text_delta") return [{ type: "text-delta", id: block.id, delta: event.delta.text }];
        if (event.delta.type === "thinking_delta") return [{ type: "reasoning-delta", id: block.id, delta: event.delta.thinking }];
      }
      if (event.type === "content_block_stop") {
        blocks.delete(event.index);
        return [{ type: `${block.type}-end`, id: block.id }];
      }
      return [];
    }
    if (message.type === "assistant") {
      if (message.error === "authentication_failed") signedOut = true;
      return message.message.content.flatMap((block): UIMessageChunk[] => {
        if (block.type !== "tool_use") return [];
        shown.add(block.id);
        const raw = block.input as Record<string, unknown>;
        const input = typeof raw.file_path === "string" ? { ...raw, file_path: resolveFile(raw.file_path) } : raw;
        return [{ type: "tool-input-available", toolCallId: block.id, toolName: block.name, input, title: title(block.name, input), providerExecuted: true }];
      });
    }
    if (message.type === "user" && Array.isArray(message.message.content)) {
      return message.message.content.flatMap((block): UIMessageChunk[] => {
        if (block.type !== "tool_result") return [];
        const toolCallId = block.tool_use_id;
        if (denied.has(toolCallId)) return [{ type: "tool-output-denied", toolCallId }];
        if (!block.is_error) return [{ type: "tool-output-available", toolCallId, output: null, providerExecuted: true }];
        const content = block.content;
        const errorText = typeof content === "string" ? content : (content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("");
        return [{ type: "tool-output-error", toolCallId, errorText, providerExecuted: true }];
      });
    }
    if (message.type === "result" && message.is_error) {
      const errorText = signedOut
        ? "Sign in to Claude in Settings to use the assistant."
        : message.subtype === "success"
          ? message.result
          : message.errors.join("\n") || "The assistant stopped with an error.";
      return [{ type: "error", errorText }];
    }
    return [];
  }

  return { convert, shown: (id: string) => shown.has(id), deny: (id: string) => denied.add(id) };
}

/**
 * Runs Claude through the Agent SDK on the person's Claude subscription, with the library as its working directory.
 * Chunks go to `send`; each reply starts with a `start` chunk and ends with `finish`, as does each part of it
 * either side of a change the person has to approve.
 */
export function createAssistant(
  libraryPath: string,
  guide: string,
  send: (chunk: UIMessageChunk) => void,
  run: typeof query = query,
) {
  const systemPrompt = `You are the assistant in Smrt, a PDF library and reader. Answer briefly, in markdown.

The working directory is the person's library. Each folder in it holds PDFs, markdown notes (.md), flashcard decks (.cards), quizzes (.quiz) and interactive HTML pages (.html). Paths given to you are absolute.

- Read a file before answering questions about it.
- Only write .md, .cards, .quiz and .html files. A PDF's .notes.json, .annotations.json and .position.json files belong to Smrt.
- A .cards file is JSON: {"cards": [{"id": "<a new UUID>", "front": "<markdown>", "back": "<markdown>"}]}. Keep each existing card's "review" field, which Smrt uses to schedule study.
- A quiz is JSON: {"title": "<short>", "questions": [...]}. Every question has a "prompt" and may have an "explanation", both markdown, and is one of:
  {"type": "choice", "choices": ["<markdown>", ...], "answer": <index of the right choice, or a list of indexes when several are right>}
  {"type": "truefalse", "answer": true}
  {"type": "blank", "answer": ["<an accepted answer>", "<another spelling>"]}, where the person types a word or two
- To quiz or test the person, put that JSON in your reply in a \`\`\`quiz code block, which Smrt shows as an interactive quiz, instead of writing the questions out or making an HTML page. Mix the question types, and don't give the answers away around the block. Write it to a .quiz file only when they ask to keep it.
- New files go in the folder the person is working in, or the one they name.

${guide}`;

  // Claude Code reports real paths, so a symlinked library would otherwise count as outside itself.
  libraryPath = fs.realpathSync(libraryPath);
  const resolveFile = (file: string) => path.resolve(libraryPath, file);
  let sessionId: string | undefined;
  let running: AbortController | null = null;
  let flushQueued: (() => void) | null = null;
  /** Changes waiting for their tool call to reach the renderer, and those waiting for the person's answer. */
  const queued = new Map<string, (approved: boolean) => void>();
  const asked = new Map<string, (approved: boolean) => void>();
  let login: ChildProcess | null = null;

  function inLibrary(file: string) {
    try {
      const target = realTarget(resolveFile(file));
      return target === libraryPath || target.startsWith(libraryPath + path.sep);
    } catch {
      return false;
    }
  }

  function ask({ text, context, model, fresh }: Ask) {
    stop();
    const controller = (running = new AbortController());
    if (fresh) sessionId = undefined;
    const converter = createConverter((file) => {
      try {
        return fs.existsSync(realTarget(resolveFile(file)));
      } catch {
        return false;
      }
    }, resolveFile);
    const emit = (chunk: UIMessageChunk) => controller === running && send(chunk);

    // Asks one approval at a time, once the renderer has the tool call it belongs to.
    function askQueued() {
      if (controller !== running || asked.size > 0) return;
      for (const [id, answer] of queued) {
        if (!converter.shown(id)) continue;
        queued.delete(id);
        asked.set(id, answer);
        emit({ type: "tool-approval-request", approvalId: id, toolCallId: id });
        emit({ type: "finish" });
        return;
      }
    }
    flushQueued = askQueued;

    const canUseTool: CanUseTool = async (tool, input, { toolUseID }) => {
      const file = String(input.file_path ?? input.path ?? ".");
      if (
        !inLibrary(file) ||
        (tool === "Glob" && hasParentSegment(input.pattern)) ||
        (tool === "Grep" && hasParentSegment(input.glob))
      ) {
        return { behavior: "deny", message: "Only files in the library can be used." };
      }
      if (tool === "Write" || tool === "Edit") {
        if (!/\.(md|cards|quiz|html)$/i.test(file)) {
          return { behavior: "deny", message: "Only markdown files, flashcard decks, quizzes and HTML pages can be written." };
        }
        // New files are harmless; changing one needs the person's go-ahead.
        if (tool === "Edit" || fs.existsSync(realTarget(resolveFile(file)))) {
          const approved = await new Promise<boolean>((resolve) => {
            queued.set(toolUseID, resolve);
            askQueued();
          });
          if (!approved) {
            converter.deny(toolUseID);
            return { behavior: "deny", message: "The person declined this change." };
          }
        }
      }
      return { behavior: "allow", updatedInput: input };
    };

    void (async () => {
      emit({ type: "start" });
      try {
        const messages = run({
          prompt: context ? `I'm looking at ${context}.\n\n${text}` : text,
          options: {
            cwd: libraryPath,
            pathToClaudeCodeExecutable: run === query ? claude() : "",
            model,
            // shortcut: a retried reply resumes a session that still holds the first attempt; fork the session if that confuses replies.
            resume: sessionId,
            abortController: controller,
            includePartialMessages: true,
            thinking: { type: "adaptive", display: "summarized" },
            tools,
            settingSources: [],
            systemPrompt,
            canUseTool,
            env,
          },
        });
        for await (const message of messages) {
          if ("session_id" in message) sessionId = message.session_id;
          for (const chunk of converter.convert(message)) emit(chunk);
          askQueued();
        }
      } catch (error) {
        if (!controller.signal.aborted) emit({ type: "error", errorText: error instanceof Error ? error.message : String(error) });
      }
      if (controller === running) flushQueued = null;
      emit({ type: "finish" });
    })();
  }

  function answer(approvalId: string, approved: boolean) {
    const resolve = asked.get(approvalId);
    if (!resolve) return;
    asked.delete(approvalId);
    send({ type: "start" });
    resolve(approved);
    flushQueued?.();
  }

  function stop() {
    running?.abort();
    running = null;
    flushQueued = null;
    for (const resolve of queued.values()) resolve(false);
    for (const resolve of asked.values()) resolve(false);
    queued.clear();
    asked.clear();
  }

  function account() {
    return new Promise<Account>((resolve) =>
      // Exits with 1 when signed out, still printing the status.
      execFile(claude(), ["auth", "status", "--json"], { env }, (_error, stdout) => {
        try {
          resolve(JSON.parse(stdout));
        } catch {
          resolve({ loggedIn: false });
        }
      }),
    );
  }

  /** Opens the browser to sign in to a Claude subscription; resolves once signed in. */
  function signIn() {
    login?.kill();
    const child = (login = spawn(claude(), ["auth", "login", "--claudeai"], { env, stdio: ["pipe", "ignore", "ignore"] }));
    child.stdin?.on("error", () => {});
    return new Promise<void>((resolve, reject) => {
      child.on("error", (error) => {
        if (login === child) login = null;
        reject(error);
      });
      child.on("exit", (code) => {
        if (login === child) login = null;
        if (code === 0) resolve();
        else reject(new Error("Signing in didn't finish. Try again."));
      });
    });
  }

  /** The code the browser shows when it can't hand the sign-in back by itself. */
  const enterSignInCode = (code: string) => {
    if (login?.stdin?.writable) login.stdin.write(String(code).trim() + "\n");
  };

  const killLogin = () => {
    login?.kill();
    login = null;
  };

  return { ask, answer, stop, account, signIn, enterSignInCode, killLogin };
}
