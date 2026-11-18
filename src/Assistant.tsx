import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { useChat } from "@ai-sdk/react";
import { getToolName, isToolUIPart, type UIMessage } from "ai";
import { defaultFilter } from "cmdk";
import { Streamdown } from "streamdown";
import { Button } from "$lib/components/ui/button";
import { Command, CommandItem, CommandList } from "$lib/components/ui/command";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "$lib/components/ui/message-scroller";
import { assistant, chat, models, useAssistant } from "./assistant.ts";
import { contextMenu } from "./ContextMenu.tsx";
import FileIcon from "./FileIcon.tsx";
import Icon, { streamdownIcons, type IconName } from "./Icon.tsx";
import Quiz from "./Quiz.tsx";
import { parseQuiz, quizSegments } from "./quiz.ts";
import { grow } from "./transitions.ts";

type Part = UIMessage["parts"][number];

const fileName = (path: string) => path.split(/[\\/]/).pop()!;
const baseName = (path: string) => fileName(path).replace(/\.(pdf|md|cards|quiz|html)$/i, "");
const fileType = (path: string) =>
  /\.md$/i.test(path) ? "md" : /\.cards$/i.test(path) ? "cards" : /\.quiz$/i.test(path) ? "quiz" : /\.html$/i.test(path) ? "html" : "pdf";
const filesOf = (message: UIMessage) => (message.metadata as { files?: string[] } | undefined)?.files ?? [];
const textOf = (message: UIMessage) => message.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
const toolIcons: Record<string, IconName> = {
  Read: "document",
  Glob: "library",
  Grep: "library",
  Write: "pencil",
  Edit: "pencil",
};

export default function Assistant({
  mode,
  context,
  active,
  inset = 0,
  onopen,
  onpin,
}: {
  /** `page` fills an empty pane; `dock` floats over an open file. */
  mode: "page" | "dock";
  /** The file the assistant is looking at, if any. */
  context: string | null;
  active: boolean;
  inset?: number;
  /** Opens a file in this pane, or `beside` it. */
  onopen: (path: string, beside?: boolean) => void;
  onpin?: () => void;
}) {
  const { messages, status, error, sendMessage, stop, setMessages, regenerate, addToolApprovalResponse } = useChat({ chat });
  const { library, recent, model } = useAssistant();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  /** Off once the person removes the file chip, until they add it back. */
  const [attach, setAttach] = useState(true);
  const [copied, setCopied] = useState<string | null>(null);
  /** The person's choice for each reasoning line; until they click, it follows the stream. */
  const [reasoningOpen, setReasoningOpen] = useState<Record<string, boolean>>({});
  /** Files picked with @ for the draft. */
  const [mentions, setMentions] = useState<string[]>([]);
  /** The word after @ at the caret, while picking a file. */
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const mentionList = useRef<HTMLDivElement>(null);
  /** The highlighted file's path. */
  const [mentionValue, setMentionValue] = useState("");

  const streaming = status === "submitted" || status === "streaming";
  const libraryFiles = () =>
    library.flatMap((f) => [...f.pdfs, ...f.markdown, ...f.decks, ...f.quizzes, ...f.html].map((file) => ({ ...file, folder: f.name })));
  const mentionMatches =
    mentionQuery == null
      ? []
      : libraryFiles()
          .filter((file) => !mentions.includes(file.path))
          .map((file) => ({ file, score: defaultFilter(baseName(file.path), mentionQuery, [file.folder]) }))
          .filter(({ score }) => score > 0)
          .sort((a, b) => b.score - a.score)
          .map(({ file }) => file);
  const files = new Map(libraryFiles().map((file) => [file.path, file]));
  const recentFiles = recent.flatMap((path) => files.get(path) ?? []).slice(0, 6);

  // Highlights the best match as the query changes.
  const best = mentionMatches[0]?.path ?? "";
  useEffect(() => setMentionValue(best), [mentionQuery, mentions, library]);
  useEffect(() => {
    mentionList.current?.querySelector("[data-selected=true]")?.scrollIntoView({ block: "nearest" });
  }, [mentionValue]);

  useEffect(() => {
    function onkeydown(event: KeyboardEvent) {
      const mod = window.smrt.platform === "darwin" ? event.metaKey : event.ctrlKey;
      if (!active || event.defaultPrevented) return;
      if (mod && !event.shiftKey && event.key.toLowerCase() === "j") {
        event.preventDefault();
        if (mode === "dock" && open && document.activeElement === field.current) setOpen(false);
        else focus();
      } else if (event.key === "Escape" && mode === "dock" && open) {
        setOpen(false);
      }
    }
    window.addEventListener("keydown", onkeydown);
    return () => window.removeEventListener("keydown", onkeydown);
  }, [active, mode, open]);

  async function send(text: string) {
    if (!text.trim() || streaming) return;
    const about = attach ? context : null;
    assistant.set({ context: about });
    const files = [...(about ? [about] : []), ...mentions.filter((m) => m !== about)];
    setDraft("");
    setMentions([]);
    setMentionQuery(null);
    setOpen(true);
    await sendMessage({ text, metadata: { files } });
  }

  function focus() {
    flushSync(() => setOpen(true));
    field.current?.focus();
  }

  function newChat() {
    stop();
    setMessages([]);
    setReasoningOpen({});
    focus();
  }

  function findMention() {
    const input = field.current;
    const match = input && /(?:^|\s)@([^\s@]*)$/.exec(input.value.slice(0, input.selectionStart));
    setMentionQuery(match ? match[1] : null);
  }

  function mention(path: string) {
    const input = field.current;
    if (!input) return;
    const caret = input.selectionStart;
    const start = input.value.lastIndexOf("@", caret - 1);
    flushSync(() => {
      setDraft(input.value.slice(0, start) + input.value.slice(caret));
      setMentions([...mentions, path]);
      setMentionQuery(null);
    });
    input.selectionStart = input.selectionEnd = start;
    input.focus();
  }

  function stepMention(step: number) {
    const index = mentionMatches.findIndex((file) => file.path === mentionValue);
    setMentionValue(mentionMatches[(index + step + mentionMatches.length) % mentionMatches.length].path);
  }

  async function pickModel() {
    const id = await contextMenu(models);
    if (id) assistant.set({ model: id });
  }

  async function copy(message: UIMessage) {
    await navigator.clipboard.writeText(textOf(message));
    setCopied(message.id);
    setTimeout(() => setCopied((copied) => (copied === message.id ? null : copied)), 2000);
  }

  /** A muted status line for a tool call or reasoning step; `running` shimmers it. */
  const statusLine = (icon: IconName, title: string, status?: "running" | "pending" | "error") => (
    <span
      className={`flex min-w-0 items-center gap-2 text-sm text-muted-foreground transition-colors
        ${status === "error" ? "text-destructive" : ""} ${status === "pending" ? "opacity-60" : ""}`}
    >
      <Icon name={icon} size={16} />
      <span className={`truncate ${status === "running" ? "shimmer" : ""}`}>{title}</span>
    </span>
  );

  function toolLine(part: Extract<Part, { toolCallId: string }>, live: boolean) {
    const icon = toolIcons[getToolName(part)] ?? "sparkles";
    const done = part.state === "output-available";
    const title = (part.title ?? getToolName(part)).replace(/^(Edit|Create)\b/, (verb) => (done ? `${verb}${verb.endsWith("e") ? "d" : "ed"}` : verb));
    const denied = part.state === "output-denied" || (part.state === "approval-responded" && !part.approval.approved);
    const path = (part.input as { file_path?: string } | undefined)?.file_path;
    const status = part.state === "output-error" ? "error" : done || denied ? undefined : live ? "running" : "pending";
    if (part.state === "approval-requested")
      return (
        <div className="flex items-center gap-3 rounded-xl bg-(--hover) p-3">
          <div className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
            <Icon name={icon} size={16} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{title}?</div>
            <div className="text-xs text-muted-foreground">The assistant wants to change this file.</div>
          </div>
          <Button size="sm" variant="ghost" onClick={() => addToolApprovalResponse({ id: part.approval.id, approved: false })}>
            Deny
          </Button>
          <Button size="sm" onClick={() => addToolApprovalResponse({ id: part.approval.id, approved: true })}>
            Allow
          </Button>
        </div>
      );
    if (path && done)
      return (
        <button
          className="w-fit max-w-full border-0 bg-transparent p-0 hover:[&>span]:text-foreground"
          onClick={() => onopen(path, true)}
          title={`Open ${fileName(path)}`}
        >
          {statusLine(icon, title)}
        </button>
      );
    return statusLine(icon, denied ? `Didn't ${title.charAt(0).toLowerCase()}${title.slice(1)}` : title, status);
  }

  function reasoningLine(id: string, text: string, running: boolean) {
    const icon = running ? "sparkles" : "checklist";
    const title = running ? "Thinking" : "Thought";
    if (text.length === 0) return statusLine(icon, title, running ? "running" : undefined);
    return (
      <details open={reasoningOpen[id] ?? running}>
        {/* Driven by `open` so it follows the stream until the person clicks. */}
        <summary
          className="w-fit cursor-pointer list-none hover:[&>span]:text-foreground [&::-webkit-details-marker]:hidden"
          onClick={(event) => {
            event.preventDefault();
            setReasoningOpen({ ...reasoningOpen, [id]: !(reasoningOpen[id] ?? running) });
          }}
        >
          {statusLine(icon, title, running ? "running" : undefined)}
        </summary>
        <div className="mt-2 pl-6 text-sm leading-relaxed whitespace-pre-wrap text-muted-foreground">{text}</div>
      </details>
    );
  }

  function assistantMessage(message: UIMessage, index: number, compact: boolean) {
    const live = streaming && index === messages.length - 1;
    return (
      <div className="flex min-w-0 flex-col gap-3 select-text">
        {message.parts.map((part, i): ReactNode => {
          if (part.type === "reasoning") return <Fragment key={i}>{reasoningLine(`${message.id}-${i}`, part.text, live && part.state === "streaming")}</Fragment>;
          if (isToolUIPart(part)) return <Fragment key={i}>{toolLine(part, live)}</Fragment>;
          if (part.type !== "text") return null;
          return quizSegments(part.text).map((segment, j) => {
            const key = `${i}-${j}`;
            const quiz = segment.type === "quiz" && segment.complete ? parseQuiz(segment.text) : null;
            if (quiz) return <Quiz key={key} quiz={quiz} compact={compact} />;
            if (segment.type === "quiz" && !segment.complete && live) return <Fragment key={key}>{statusLine("checklist", "Writing a quiz", "running")}</Fragment>;
            return (
              // A quiz that can't be read shows as the JSON it is.
              <Streamdown
                key={key}
                icons={streamdownIcons}
                className={`flex flex-col gap-3 leading-relaxed *:m-0 ${compact ? "text-sm" : "text-[15px]"} [&_:is(ul,ol)]:m-0 [&_:is(ul,ol)]:p-0`}
                animated={{ animation: "fadeIn", sep: "word" }}
                isAnimating={live}
              >
                {segment.type === "quiz" ? `\`\`\`json\n${segment.text}\n\`\`\`` : segment.text}
              </Streamdown>
            );
          });
        })}
        {live && message.parts.length === 0 && statusLine("sparkles", "Working", "running")}
        {!live && textOf(message) && (
          <div className="-ml-2 flex gap-0.5">
            <Button variant="ghost" size="icon-sm" className="[&_svg]:size-5!" aria-label="Copy" title="Copy" onClick={() => copy(message)}>
              <Icon name={copied === message.id ? "check" : "copy"} />
            </Button>
            {index === messages.length - 1 && (
              <Button
                variant="ghost"
                size="icon-sm"
                className="[&_svg]:size-5!"
                aria-label="Retry"
                title="Retry"
                onClick={() => regenerate({ messageId: message.id })}
              >
                <Icon name="retry" />
              </Button>
            )}
          </div>
        )}
      </div>
    );
  }

  const thread = (compact: boolean) => (
    <MessageScrollerProvider autoScroll>
      <MessageScroller className="min-h-0 flex-1">
        <MessageScrollerViewport>
          <MessageScrollerContent className={compact ? "gap-5 px-4 py-4" : "mx-auto w-full max-w-2xl gap-8 px-6 pt-14 pb-6"}>
            {messages.map((message, index) => (
              <MessageScrollerItem key={message.id} messageId={message.id} scrollAnchor={message.role === "user"}>
                {message.role === "user" ? (
                  <>
                    {filesOf(message).length > 0 && (
                      <div className="mb-1.5 ml-auto flex w-fit max-w-[80%] flex-wrap justify-end gap-1.5 [&>span]:bg-muted">
                        {filesOf(message).map((path) => fileChip(path))}
                      </div>
                    )}
                    <div
                      className={`ml-auto w-fit max-w-[80%] rounded-xl bg-muted px-3 py-2 leading-relaxed wrap-break-word whitespace-pre-wrap select-text
                        ${compact ? "text-sm" : "text-[15px]"}`}
                    >
                      {textOf(message)}
                    </div>
                  </>
                ) : (
                  assistantMessage(message, index, compact)
                )}
              </MessageScrollerItem>
            ))}
            {error && (
              <MessageScrollerItem messageId="error">
                <p className="text-sm text-destructive">{error.message}</p>
              </MessageScrollerItem>
            )}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton>
          <Icon name="arrowDown" />
          <span className="sr-only">Scroll to end</span>
        </MessageScrollerButton>
      </MessageScroller>
    </MessageScrollerProvider>
  );

  const fileChip = (path: string, onremove?: () => void) => (
    <span
      key={path}
      className={`inline-flex h-6 max-w-full items-center gap-1.5 rounded-md bg-(--background) pl-1.5 text-xs ${onremove ? "pr-0.5" : "pr-2"}`}
    >
      <FileIcon type={fileType(path)} size={14} />
      <span className="truncate">{baseName(path)}</span>
      {onremove && (
        <Button variant="ghost" size="icon-xs" className="size-5" aria-label={`Don't include ${baseName(path)}`} onClick={onremove}>
          <Icon name="close" />
        </Button>
      )}
    </span>
  );

  const composer = (large: boolean) => (
    <form
      className="relative flex flex-col rounded-3xl bg-(--hover)"
      onSubmit={(event) => {
        event.preventDefault();
        send(draft);
      }}
    >
      {(context || mentions.length > 0) && (
        <div className="flex flex-wrap gap-1.5 px-2.5 pt-2.5">
          {context && attach
            ? fileChip(context, () => setAttach(false))
            : context && (
                <Button variant="ghost" size="xs" className="text-muted-foreground" onClick={() => setAttach(true)}>
                  <Icon name="add" /> {baseName(context)}
                </Button>
              )}
          {mentions
            .filter((m) => m !== context || !attach)
            .map((path) => fileChip(path, () => setMentions(mentions.filter((m) => m !== path))))}
        </div>
      )}
      <textarea
        ref={field}
        value={draft}
        rows={1}
        placeholder={context && attach ? `Ask about ${baseName(context)}. @ files` : "Ask anything. @ files"}
        className={`field-sizing-content m-0 max-h-48 resize-none border-0 bg-transparent px-3.5 font-[inherit] text-inherit outline-none placeholder:text-muted-foreground
          ${large ? "min-h-28 pt-4 pb-2" : "pt-3 pb-1"} ${mode === "page" ? "text-base" : "text-sm"}`}
        onChange={(event) => {
          setDraft(event.target.value);
          findMention();
        }}
        onClick={findMention}
        onBlur={() => setMentionQuery(null)}
        onKeyDown={(event) => {
          const composing = event.nativeEvent.isComposing;
          if (mentionMatches.length && !composing) {
            const step = ({ ArrowDown: 1, ArrowUp: -1 } as Record<string, number>)[event.key];
            if (step) stepMention(step);
            else if ((event.key === "Enter" || event.key === "Tab") && mentionValue) mention(mentionValue);
            else if (event.key === "Escape") setMentionQuery(null);
            else return;
            event.preventDefault();
            return;
          }
          if (event.key === "Enter" && !event.shiftKey && !composing) {
            event.preventDefault();
            send(draft);
          }
        }}
      ></textarea>
      {mentionMatches.length > 0 && (
        <Command
          value={mentionValue}
          onValueChange={setMentionValue}
          shouldFilter={false}
          loop
          label="Files"
          className={`absolute left-0 z-10 h-auto w-max max-w-full min-w-64 rounded-2xl! bg-(--background) p-1.5 text-(--foreground) shadow-[0_0_0_0.5px_var(--separator),0_8px_32px_rgb(0_0_0/0.2)]
            ${large ? "top-full mt-2" : "bottom-full mb-2"}`}
        >
          {/* Keeps focus in the textarea, which drives the list. */}
          <CommandList ref={mentionList} onPointerDown={(event) => event.preventDefault()}>
            {mentionMatches.map((file) => (
              // The last svg is the item's check mark, which a file list has no use for.
              <CommandItem
                key={file.path}
                value={file.path}
                className="rounded-lg data-selected:bg-(--hover) [&>svg:last-child]:hidden"
                onSelect={() => mention(file.path)}
              >
                <FileIcon type={fileType(file.path)} size={16} />
                <span className="truncate">{baseName(file.path)}</span>
                <span className="ml-auto shrink-0 pl-3 text-xs text-muted-foreground">{file.folder}</span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      )}
      <div className="flex items-center gap-1 px-2.5 pb-2">
        {/* Sized by the button's important class, as Button's own icon rule is more specific; nudged down to sit on the text's cap height. */}
        <Button
          variant="ghost"
          size="sm"
          className={`ml-auto gap-2 font-normal [&_svg]:translate-y-px text-muted-foreground ${mode === "page" ? "text-[13px] [&_svg]:size-5!" : "text-xs [&_svg]:size-[18px]!"}`}
          onClick={pickModel}
        >
          <Icon name="claude" />
          {models.find((m) => m.id === model)?.label}
        </Button>
        {streaming ? (
          <Button size="icon-sm" className="rounded-full" aria-label="Stop" onClick={() => stop()}>
            <Icon name="stop" />
          </Button>
        ) : (
          <Button type="submit" size="icon-sm" className="rounded-full" aria-label="Send" disabled={!draft.trim()}>
            <Icon name="arrowUp" />
          </Button>
        )}
      </div>
    </form>
  );

  if (mode === "page")
    return (
      <div className="assistant-page absolute inset-0 flex flex-col bg-(--background) text-(--foreground)" style={{ paddingLeft: inset }}>
        {messages.length > 0 ? (
          <>
            <div className="absolute top-2.5 right-3 z-[2] flex gap-1 [-webkit-app-region:no-drag]">
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground [&_svg]:size-5!"
                title="New Chat"
                aria-label="New Chat"
                onClick={newChat}
              >
                <Icon name="notes" />
              </Button>
            </div>
            {thread(false)}
            <div className="mx-auto w-full max-w-2xl px-6 pb-5">{composer(false)}</div>
          </>
        ) : (
          <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center gap-8 px-6 pb-[12vh]">
            <h1 className="brand m-0 text-center text-[32px]">What are we learning today?</h1>
            {composer(true)}
            {recentFiles.length > 0 && (
              <section className="flex flex-col gap-2 px-1">
                <h2 className="m-0 px-2 text-xs font-medium text-muted-foreground">Recent</h2>
                <div className="grid grid-cols-2 gap-1">
                  {recentFiles.map((file) => (
                    <button
                      key={file.path}
                      className="flex min-w-0 items-center gap-2.5 rounded-xl border-0 bg-transparent px-2.5 py-2 text-left text-sm text-inherit hover:bg-(--hover)"
                      onClick={() => onopen(file.path)}
                    >
                      <FileIcon type={fileType(file.path)} size={18} />
                      <span className="truncate">{baseName(file.path)}</span>
                      <span className="ml-auto shrink-0 pl-2 text-xs text-muted-foreground">{file.folder}</span>
                    </button>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </div>
    );

  return (
    <AnimatePresence initial={false}>
      {open ? (
        <motion.div
          key="panel"
          className="absolute right-3 bottom-3 z-[3] flex max-h-[min(640px,calc(100%-24px))] w-[400px] max-w-[calc(100%-24px)] origin-bottom-right flex-col rounded-[calc(var(--radius-3xl)+12px)] bg-(--background) text-(--foreground) shadow-[0_0_0_0.5px_var(--separator),0_8px_32px_rgb(0_0_0/0.2)]"
          {...grow(0.92)}
        >
          <div className="flex h-12 shrink-0 items-center gap-1 pt-1 pr-3.5 pl-5">
            <span className="text-muted-foreground">
              <Icon name="sparkles" size={16} />
            </span>
            <span className="mr-auto text-sm font-medium">Assistant</span>
            {messages.length > 0 && (
              <Button variant="ghost" size="icon-sm" title="New Chat" aria-label="New Chat" onClick={newChat}>
                <Icon name="notes" />
              </Button>
            )}
            {onpin && (
              <Button variant="ghost" size="icon-sm" title="Open in Split View" aria-label="Open in Split View" onClick={onpin}>
                <Icon name="sidebar" />
              </Button>
            )}
            <Button variant="ghost" size="icon-sm" title="Close (Esc)" aria-label="Close" onClick={() => setOpen(false)}>
              <Icon name="chevronDown" />
            </Button>
          </div>
          {messages.length > 0 && thread(true)}
          <div className="shrink-0 p-3">{composer(false)}</div>
        </motion.div>
      ) : (
        <motion.button
          key="button"
          className="floating absolute right-3 bottom-3 z-[3] grid size-10 border-0 p-0 place-items-center text-muted-foreground transition-colors hover:text-foreground"
          title="Ask Assistant (⌘J)"
          aria-label="Ask Assistant"
          onClick={focus}
          {...grow(0.6)}
        >
          <Icon name="sparkles" size={18} />
          {streaming && <span className="absolute top-1.5 right-1.5 size-2 animate-pulse rounded-full bg-sky-500"></span>}
        </motion.button>
      )}
    </AnimatePresence>
  );
}
