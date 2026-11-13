<script lang="ts">
  import { tick } from "svelte";
  import { cubicOut } from "svelte/easing";
  import { scale } from "svelte/transition";
  import { getToolName, isToolUIPart, type UIMessage } from "ai";
  import { Streamdown } from "svelte-streamdown";
  import { Button } from "$lib/components/ui/button";
  import * as Command from "$lib/components/ui/command";
  import * as MessageScroller from "$lib/components/ui/message-scroller";
  import { computeCommandScore, type Command as CommandPrimitive } from "bits-ui";
  import { assistant, chat, models } from "./assistant.svelte.ts";
  import { contextMenu } from "./ContextMenu.svelte";
  import FileIcon from "./FileIcon.svelte";
  import Icon, { streamdownIcons, type IconName } from "./Icon.svelte";
  import Quiz from "./Quiz.svelte";
  import { parseQuiz, quizSegments } from "./quiz.ts";

  let {
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
  } = $props();

  type Part = UIMessage["parts"][number];

  let open = $state(false);
  let draft = $state("");
  let field: HTMLTextAreaElement | null = $state(null);
  /** Off once the person removes the file chip, until they add it back. */
  let attach = $state(true);
  let copied: string | null = $state(null);
  /** The person's choice for each reasoning line; until they click, it follows the stream. */
  let reasoningOpen: Record<string, boolean> = $state({});
  /** Files picked with @ for the draft. */
  let mentions: string[] = $state([]);
  /** The word after @ at the caret, while picking a file. */
  let mentionQuery: string | null = $state(null);
  let mentionList: CommandPrimitive.Root | null = $state(null);
  /** The highlighted file's path. */
  let mentionValue = $state("");

  const streaming = $derived(chat.status === "submitted" || chat.status === "streaming");
  const fileName = (path: string) => path.split(/[\\/]/).pop()!;
  const baseName = (path: string) => fileName(path).replace(/\.(pdf|md|cards|quiz|html)$/i, "");
  const fileType = (path: string) =>
    /\.md$/i.test(path) ? "md" : /\.cards$/i.test(path) ? "cards" : /\.quiz$/i.test(path) ? "quiz" : /\.html$/i.test(path) ? "html" : "pdf";
  const filesOf = (message: UIMessage) => (message.metadata as { files?: string[] } | undefined)?.files ?? [];
  const textOf = (message: UIMessage) => message.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
  const mentionMatches = $derived(
    mentionQuery == null
      ? []
      : assistant.library
          .flatMap((f) => [...f.pdfs, ...f.markdown, ...f.decks, ...f.quizzes, ...f.html].map((file) => ({ ...file, folder: f.name })))
          .filter((file) => !mentions.includes(file.path))
          .map((file) => ({ file, score: computeCommandScore(baseName(file.path), mentionQuery!, [file.folder]) }))
          .filter(({ score }) => score > 0)
          .sort((a, b) => b.score - a.score)
          .map(({ file }) => file),
  );
  const recentFiles = $derived.by(() => {
    const files = new Map(
      assistant.library.flatMap((f) => [...f.pdfs, ...f.markdown, ...f.decks, ...f.quizzes, ...f.html].map((file) => [file.path, { ...file, folder: f.name }])),
    );
    return assistant.recent.flatMap((path) => files.get(path) ?? []).slice(0, 6);
  });
  // Highlights the best match as the query changes.
  $effect(() => {
    mentionValue = mentionMatches[0]?.path ?? "";
  });
  const toolIcons: Record<string, IconName> = {
    Read: "document",
    Glob: "library",
    Grep: "library",
    Write: "pencil",
    Edit: "pencil",
  };

  async function send(text: string) {
    if (!text.trim() || streaming) return;
    assistant.context = attach ? context : null;
    const files = [...(assistant.context ? [assistant.context] : []), ...mentions.filter((m) => m !== assistant.context)];
    draft = "";
    mentions = [];
    mentionQuery = null;
    open = true;
    await chat.sendMessage({ text, metadata: { files } });
  }

  async function focus() {
    open = true;
    await tick();
    field?.focus();
  }

  function newChat() {
    chat.stop();
    chat.messages = [];
    reasoningOpen = {};
    focus();
  }

  function findMention() {
    // Reads the field, as this can run before the binding updates `draft`.
    const match = field && /(?:^|\s)@([^\s@]*)$/.exec(field.value.slice(0, field.selectionStart));
    mentionQuery = match ? match[1] : null;
  }

  async function mention(path: string) {
    if (!field) return;
    const caret = field.selectionStart;
    const start = draft.lastIndexOf("@", caret - 1);
    draft = draft.slice(0, start) + draft.slice(caret);
    mentions.push(path);
    mentionQuery = null;
    await tick();
    field.selectionStart = field.selectionEnd = start;
    field.focus();
  }

  async function pickModel() {
    const id = await contextMenu(models);
    if (id) assistant.model = id;
  }

  async function copy(message: UIMessage) {
    await navigator.clipboard.writeText(textOf(message));
    copied = message.id;
    setTimeout(() => copied === message.id && (copied = null), 2000);
  }
</script>

<svelte:window
  onkeydown={(event) => {
    const mod = window.smrt.platform === "darwin" ? event.metaKey : event.ctrlKey;
    if (!active || event.defaultPrevented) return;
    if (mod && !event.shiftKey && event.key.toLowerCase() === "j") {
      event.preventDefault();
      if (mode === "dock" && open && document.activeElement === field) open = false;
      else focus();
    } else if (event.key === "Escape" && mode === "dock" && open) {
      open = false;
    }
  }}
/>

<!-- A muted status line for a tool call or reasoning step; `running` shimmers it. -->
{#snippet statusLine(icon: IconName, title: string, status?: "running" | "pending" | "error")}
  <span
    class="flex min-w-0 items-center gap-2 text-sm text-muted-foreground transition-colors
      {status === 'error' ? 'text-destructive' : ''} {status === 'pending' ? 'opacity-60' : ''}"
  >
    <Icon name={icon} size={16} />
    <span class="truncate {status === 'running' ? 'shimmer' : ''}">{title}</span>
  </span>
{/snippet}

{#snippet toolLine(part: Extract<Part, { toolCallId: string }>, live: boolean)}
  {@const icon = toolIcons[getToolName(part)] ?? "sparkles"}
  {@const done = part.state === "output-available"}
  {@const title = (part.title ?? getToolName(part)).replace(/^(Edit|Create)\b/, (verb) => (done ? `${verb}${verb.endsWith("e") ? "d" : "ed"}` : verb))}
  {@const denied = part.state === "output-denied" || (part.state === "approval-responded" && !part.approval.approved)}
  {@const path = (part.input as { file_path?: string } | undefined)?.file_path}
  {@const status = part.state === "output-error" ? "error" : done || denied ? undefined : live ? "running" : "pending"}
  {#if part.state === "approval-requested"}
    <div class="flex items-center gap-3 rounded-xl bg-(--hover) p-3">
      <div class="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground"><Icon name={icon} size={16} /></div>
      <div class="min-w-0 flex-1">
        <div class="truncate text-sm font-medium">{title}?</div>
        <div class="text-xs text-muted-foreground">The assistant wants to change this file.</div>
      </div>
      <Button size="sm" variant="ghost" onclick={() => chat.addToolApprovalResponse({ id: part.approval.id, approved: false })}>Deny</Button>
      <Button size="sm" onclick={() => chat.addToolApprovalResponse({ id: part.approval.id, approved: true })}>Allow</Button>
    </div>
  {:else if path && done}
    <button class="w-fit max-w-full border-0 bg-transparent p-0 hover:[&>span]:text-foreground" onclick={() => onopen(path, true)} title="Open {fileName(path)}">
      {@render statusLine(icon, title)}
    </button>
  {:else}
    {@render statusLine(icon, denied ? `Didn't ${title.charAt(0).toLowerCase()}${title.slice(1)}` : title, status)}
  {/if}
{/snippet}

{#snippet reasoningLine(id: string, text: string, running: boolean)}
  {@const icon = running ? "sparkles" : "checklist"}
  {@const title = running ? "Thinking" : "Thought"}
  {#if text.length === 0}
    {@render statusLine(icon, title, running ? "running" : undefined)}
  {:else}
    <details open={reasoningOpen[id] ?? running}>
      <!-- Driven by `open` so it follows the stream until the person clicks. -->
      <summary
        class="w-fit cursor-pointer list-none hover:[&>span]:text-foreground [&::-webkit-details-marker]:hidden"
        onclick={(event) => {
          event.preventDefault();
          reasoningOpen[id] = !(reasoningOpen[id] ?? running);
        }}
      >
        {@render statusLine(icon, title, running ? "running" : undefined)}
      </summary>
      <div class="mt-2 pl-6 text-sm leading-relaxed whitespace-pre-wrap text-muted-foreground">{text}</div>
    </details>
  {/if}
{/snippet}

{#snippet thread(compact: boolean)}
  <MessageScroller.Provider autoScroll>
    <MessageScroller.Root class="min-h-0 flex-1">
      <MessageScroller.Viewport>
        <MessageScroller.Content class={compact ? "gap-5 px-4 py-4" : "mx-auto w-full max-w-2xl gap-8 px-6 pt-14 pb-6"}>
          {#each chat.messages as message, index (message.id)}
            {@const live = streaming && index === chat.messages.length - 1}
            <MessageScroller.Item messageId={message.id} scrollAnchor={message.role === "user"}>
              {#if message.role === "user"}
                {#if filesOf(message).length}
                  <div class="mb-1.5 ml-auto flex w-fit max-w-[80%] flex-wrap justify-end gap-1.5 [&>span]:bg-muted">
                    {#each filesOf(message) as path (path)}{@render fileChip(path)}{/each}
                  </div>
                {/if}
                <div
                  class="ml-auto w-fit max-w-[80%] rounded-xl bg-muted px-3 py-2 leading-relaxed wrap-break-word whitespace-pre-wrap select-text
                    {compact ? 'text-sm' : 'text-[15px]'}"
                >
                  {textOf(message)}
                </div>
              {:else}
                <div class="flex min-w-0 flex-col gap-3 select-text">
                    {#each message.parts as part, i (i)}
                      {#if part.type === "reasoning"}
                        {@render reasoningLine(`${message.id}-${i}`, part.text, live && part.state === "streaming")}
                      {:else if isToolUIPart(part)}
                        {@render toolLine(part, live)}
                      {:else if part.type === "text"}
                        {#each quizSegments(part.text) as segment, j (j)}
                          {@const quiz = segment.type === "quiz" && segment.complete ? parseQuiz(segment.text) : null}
                          {#if quiz}
                            <Quiz {quiz} {compact} />
                          {:else if segment.type === "quiz" && !segment.complete && live}
                            {@render statusLine("checklist", "Writing a quiz", "running")}
                          {:else}
                            <!-- A quiz that can't be read shows as the JSON it is. -->
                            <Streamdown
                              content={segment.type === "quiz" ? `\`\`\`json\n${segment.text}\n\`\`\`` : segment.text}
                              baseTheme="shadcn"
                              icons={streamdownIcons}
                              class="flex flex-col gap-3 leading-relaxed *:m-0 {compact ? 'text-sm' : 'text-[15px]'} [&_:is(ul,ol)]:m-0 [&_:is(ul,ol)]:p-0"
                              animation={{ enabled: true, type: "fade", tokenize: "word" }}
                            />
                          {/if}
                        {/each}
                      {/if}
                    {/each}
                    {#if live && message.parts.length === 0}
                      {@render statusLine("sparkles", "Working", "running")}
                    {/if}
                    {#if !live && textOf(message)}
                      <div class="-ml-2 flex gap-0.5">
                        <Button variant="ghost" size="icon-sm" class="[&_svg]:size-5!" aria-label="Copy" title="Copy" onclick={() => copy(message)}>
                          <Icon name={copied === message.id ? "check" : "copy"} />
                        </Button>
                        {#if index === chat.messages.length - 1}
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            class="[&_svg]:size-5!"
                            aria-label="Retry"
                            title="Retry"
                            onclick={() => chat.regenerate({ messageId: message.id })}
                          >
                            <Icon name="retry" />
                          </Button>
                        {/if}
                      </div>
                    {/if}
                </div>
              {/if}
            </MessageScroller.Item>
          {/each}
          {#if chat.error}
            <MessageScroller.Item messageId="error">
              <p class="text-sm text-destructive">{chat.error.message}</p>
            </MessageScroller.Item>
          {/if}
        </MessageScroller.Content>
      </MessageScroller.Viewport>
      <MessageScroller.Button><Icon name="arrowDown" /></MessageScroller.Button>
    </MessageScroller.Root>
  </MessageScroller.Provider>
{/snippet}

{#snippet fileChip(path: string, onremove?: () => void)}
  <span class="inline-flex h-6 max-w-full items-center gap-1.5 rounded-md bg-(--background) pl-1.5 text-xs {onremove ? 'pr-0.5' : 'pr-2'}">
    <FileIcon type={fileType(path)} size={14} />
    <span class="truncate">{baseName(path)}</span>
    {#if onremove}
      <Button variant="ghost" size="icon-xs" class="size-5" aria-label="Don't include {baseName(path)}" onclick={onremove}>
        <Icon name="close" />
      </Button>
    {/if}
  </span>
{/snippet}

{#snippet composer(large: boolean)}
  <form
    class="relative flex flex-col rounded-3xl bg-(--hover)"
    onsubmit={(event) => {
      event.preventDefault();
      send(draft);
    }}
  >
    {#if context || mentions.length}
      <div class="flex flex-wrap gap-1.5 px-2.5 pt-2.5">
        {#if context && attach}
          {@render fileChip(context, () => (attach = false))}
        {:else if context}
          <Button variant="ghost" size="xs" class="text-muted-foreground" onclick={() => (attach = true)}>
            <Icon name="add" /> {baseName(context)}
          </Button>
        {/if}
        {#each mentions.filter((m) => m !== context || !attach) as path (path)}
          {@render fileChip(path, () => mentions.splice(mentions.indexOf(path), 1))}
        {/each}
      </div>
    {/if}
    <textarea
      bind:this={field}
      bind:value={draft}
      rows={1}
      placeholder={context && attach ? `Ask about ${baseName(context)}. @ files` : "Ask anything. @ files"}
      class="field-sizing-content m-0 max-h-48 resize-none border-0 bg-transparent px-3.5 font-[inherit] text-inherit outline-none placeholder:text-muted-foreground
        {large ? 'min-h-28 pt-4 pb-2' : 'pt-3 pb-1'} {mode === 'page' ? 'text-base' : 'text-sm'}"
      oninput={findMention}
      onclick={findMention}
      onblur={() => (mentionQuery = null)}
      onkeydown={(event) => {
        if (mentionMatches.length && !event.isComposing) {
          const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
          if (step) mentionList?.updateSelectedByItem(step);
          else if ((event.key === "Enter" || event.key === "Tab") && mentionValue) mention(mentionValue);
          else if (event.key === "Escape") mentionQuery = null;
          else return;
          event.preventDefault();
          return;
        }
        if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
          event.preventDefault();
          send(draft);
        }
      }}
    ></textarea>
    {#if mentionMatches.length}
      <Command.Root
        bind:api={mentionList}
        bind:value={mentionValue}
        shouldFilter={false}
        loop
        label="Files"
        class="absolute left-0 z-10 h-auto w-max max-w-full min-w-64 rounded-2xl! bg-(--background) p-1.5 text-(--foreground) shadow-[0_0_0_0.5px_var(--separator),0_8px_32px_rgb(0_0_0/0.2)]
          {large ? 'top-full mt-2' : 'bottom-full mb-2'}"
      >
        <!-- Keeps focus in the textarea, which drives the list. -->
        <Command.List onpointerdown={(event: PointerEvent) => event.preventDefault()}>
          {#each mentionMatches as file (file.path)}
            <Command.Item value={file.path} class="rounded-lg data-selected:bg-(--hover)" onSelect={() => mention(file.path)}>
              <FileIcon type={fileType(file.path)} size={16} />
              <span class="truncate">{baseName(file.path)}</span>
              <span class="ml-auto shrink-0 pl-3 text-xs text-muted-foreground">{file.folder}</span>
            </Command.Item>
          {/each}
        </Command.List>
      </Command.Root>
    {/if}
    <div class="flex items-center gap-1 px-2.5 pb-2">
      <Button
        variant="ghost"
        size="sm"
        class="ml-auto gap-2 font-normal [&_svg]:translate-y-px text-muted-foreground {mode === 'page' ? 'text-[13px] [&_svg]:size-5!' : 'text-xs [&_svg]:size-[18px]!'}"
        onclick={pickModel}
      >
        <!-- Sized by the button's important class, as Button's own icon rule is more specific; nudged down to sit on the text's cap height. -->
        <Icon name="claude" />
        {models.find((model) => model.id === assistant.model)?.label}
      </Button>
      {#if streaming}
        <Button size="icon-sm" class="rounded-full" aria-label="Stop" onclick={() => chat.stop()}><Icon name="stop" /></Button>
      {:else}
        <Button type="submit" size="icon-sm" class="rounded-full" aria-label="Send" disabled={!draft.trim()}><Icon name="arrowUp" /></Button>
      {/if}
    </div>
  </form>
{/snippet}

{#if mode === "page"}
  <div class="assistant-page absolute inset-0 flex flex-col bg-(--background) text-(--foreground)" style:padding-left="{inset}px">
    {#if chat.messages.length > 0}
      <div class="absolute top-2.5 right-3 z-[2] flex gap-1 [-webkit-app-region:no-drag]">
        <Button variant="ghost" size="icon-sm" class="text-muted-foreground [&_svg]:size-5!" title="New Chat" aria-label="New Chat" onclick={newChat}><Icon name="notes" /></Button>
      </div>
      {@render thread(false)}
      <div class="mx-auto w-full max-w-2xl px-6 pb-5">{@render composer(false)}</div>
    {:else}
      <div class="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center gap-8 px-6 pb-[12vh]">
        <h1 class="brand m-0 text-center text-[32px]">What are we learning today?</h1>
        {@render composer(true)}
        {#if recentFiles.length}
          <section class="flex flex-col gap-2 px-1">
            <h2 class="m-0 px-2 text-xs font-medium text-muted-foreground">Recent</h2>
            <div class="grid grid-cols-2 gap-1">
              {#each recentFiles as file (file.path)}
                <button
                  class="flex min-w-0 items-center gap-2.5 rounded-xl border-0 bg-transparent px-2.5 py-2 text-left text-sm text-inherit hover:bg-(--hover)"
                  onclick={() => onopen(file.path)}
                >
                  <FileIcon type={fileType(file.path)} size={18} />
                  <span class="truncate">{baseName(file.path)}</span>
                  <span class="ml-auto shrink-0 pl-2 text-xs text-muted-foreground">{file.folder}</span>
                </button>
              {/each}
            </div>
          </section>
        {/if}
      </div>
    {/if}
  </div>
{:else if open}
  <div
    class="absolute right-3 bottom-3 z-[3] flex max-h-[min(640px,calc(100%-24px))] w-[400px] max-w-[calc(100%-24px)] origin-bottom-right flex-col rounded-[calc(var(--radius-3xl)+12px)] bg-(--background) text-(--foreground) shadow-[0_0_0_0.5px_var(--separator),0_8px_32px_rgb(0_0_0/0.2)]"
    transition:scale={{ start: 0.92, duration: 180, easing: cubicOut }}
  >
    <div class="flex h-12 shrink-0 items-center gap-1 pt-1 pr-3.5 pl-5">
      <span class="text-muted-foreground"><Icon name="sparkles" size={16} /></span>
      <span class="mr-auto text-sm font-medium">Assistant</span>
      {#if chat.messages.length > 0}
        <Button variant="ghost" size="icon-sm" title="New Chat" aria-label="New Chat" onclick={newChat}><Icon name="notes" /></Button>
      {/if}
      {#if onpin}
        <Button variant="ghost" size="icon-sm" title="Open in Split View" aria-label="Open in Split View" onclick={onpin}>
          <Icon name="sidebar" />
        </Button>
      {/if}
      <Button variant="ghost" size="icon-sm" title="Close (Esc)" aria-label="Close" onclick={() => (open = false)}><Icon name="chevronDown" /></Button>
    </div>
    {#if chat.messages.length > 0}
      {@render thread(true)}
    {/if}
    <div class="shrink-0 p-3">{@render composer(false)}</div>
  </div>
{:else}
  <button
    class="floating absolute right-3 bottom-3 z-[3] grid size-10 border-0 p-0 place-items-center text-muted-foreground transition-colors hover:text-foreground"
    title="Ask Assistant (⌘J)"
    aria-label="Ask Assistant"
    onclick={focus}
    transition:scale={{ start: 0.6, duration: 180, easing: cubicOut }}
  >
    <Icon name="sparkles" size={18} />
    {#if streaming}<span class="absolute top-1.5 right-1.5 size-2 animate-pulse rounded-full bg-sky-500"></span>{/if}
  </button>
{/if}
