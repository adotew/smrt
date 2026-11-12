<script lang="ts">
  import { tick } from "svelte";
  import { cubicOut } from "svelte/easing";
  import { scale } from "svelte/transition";
  import { getToolName, isToolUIPart, type UIMessage } from "ai";
  import { Streamdown } from "svelte-streamdown";
  import { Button } from "$lib/components/ui/button";
  import * as MessageScroller from "$lib/components/ui/message-scroller";
  import { assistant, chat, models } from "./assistant.svelte.ts";
  import { contextMenu } from "./ContextMenu.svelte";
  import FileIcon from "./FileIcon.svelte";
  import Icon, { type IconName } from "./Icon.svelte";

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
    onopen: (path: string) => void;
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

  const streaming = $derived(chat.status === "submitted" || chat.status === "streaming");
  const fileName = (path: string) => path.split(/[\\/]/).pop()!;
  const baseName = (path: string) => fileName(path).replace(/\.(pdf|md|cards|html)$/i, "");
  const fileType = (path: string) =>
    /\.md$/i.test(path) ? "md" : /\.cards$/i.test(path) ? "cards" : /\.html$/i.test(path) ? "html" : "pdf";
  const textOf = (message: UIMessage) => message.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
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
    draft = "";
    open = true;
    await chat.sendMessage({ text });
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
    <button class="w-fit max-w-full border-0 bg-transparent p-0 hover:[&>span]:text-foreground" onclick={() => onopen(path)} title="Open {fileName(path)}">
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
                        <Streamdown
                          content={part.text}
                          baseTheme="shadcn"
                          class="flex flex-col gap-3 leading-relaxed *:m-0 {compact ? 'text-sm' : 'text-[15px]'} [&_:is(ul,ol)]:m-0 [&_:is(ul,ol)]:p-0"
                          animation={{ enabled: true, type: "fade", tokenize: "word" }}
                        />
                      {/if}
                    {/each}
                    {#if live && message.parts.length === 0}
                      {@render statusLine("sparkles", "Working", "running")}
                    {/if}
                    {#if !live && textOf(message)}
                      <div class="-ml-2 flex gap-0.5">
                        <Button variant="ghost" size="icon-xs" aria-label="Copy" title="Copy" onclick={() => copy(message)}>
                          <Icon name={copied === message.id ? "check" : "copy"} />
                        </Button>
                        {#if index === chat.messages.length - 1}
                          <Button
                            variant="ghost"
                            size="icon-xs"
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

{#snippet composer(large: boolean)}
  <form
    class="flex flex-col rounded-3xl bg-(--hover)"
    onsubmit={(event) => {
      event.preventDefault();
      send(draft);
    }}
  >
    {#if context}
      <div class="px-2.5 pt-2.5">
        {#if attach}
          <span class="inline-flex h-6 max-w-full items-center gap-1.5 rounded-md bg-(--background) pr-0.5 pl-1.5 text-xs">
            <FileIcon type={fileType(context)} size={14} />
            <span class="truncate">{baseName(context)}</span>
            <Button variant="ghost" size="icon-xs" class="size-5" aria-label="Don't include this file" onclick={() => (attach = false)}>
              <Icon name="close" />
            </Button>
          </span>
        {:else}
          <Button variant="ghost" size="xs" class="text-muted-foreground" onclick={() => (attach = true)}>
            <Icon name="add" /> {baseName(context)}
          </Button>
        {/if}
      </div>
    {/if}
    <textarea
      bind:this={field}
      bind:value={draft}
      rows={1}
      placeholder={context && attach ? `Ask about ${baseName(context)}…` : "Ask anything, or describe what to make…"}
      class="field-sizing-content m-0 max-h-48 resize-none border-0 bg-transparent px-3.5 font-[inherit] text-inherit outline-none placeholder:text-muted-foreground
        {large ? 'min-h-28 pt-4 pb-2' : 'pt-3 pb-1'} {mode === 'page' ? 'text-base' : 'text-sm'}"
      onkeydown={(event) => {
        if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
          event.preventDefault();
          send(draft);
        }
      }}
    ></textarea>
    <div class="flex items-center gap-1 px-2.5 pb-2">
      <Button
        variant="ghost"
        size="sm"
        class="ml-auto gap-2 font-normal [&_svg]:translate-y-px text-muted-foreground {mode === 'page' ? 'text-[14.5px] [&_svg]:size-5!' : 'text-[13.5px] [&_svg]:size-[18px]!'}"
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
        <Button variant="ghost" size="sm" class="text-muted-foreground" onclick={newChat}><Icon name="notes" /> New Chat</Button>
      </div>
      {@render thread(false)}
      <div class="mx-auto w-full max-w-2xl px-6 pb-5">{@render composer(false)}</div>
    {:else}
      <div class="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center gap-8 px-6 pb-[12vh]">
        <h1 class="brand m-0 text-center text-[32px]">What are we learning today?</h1>
        {@render composer(true)}
      </div>
    {/if}
  </div>
{:else if open}
  <div
    class="absolute right-3 bottom-3 z-[3] flex max-h-[min(640px,calc(100%-24px))] w-[400px] max-w-[calc(100%-24px)] origin-bottom-right flex-col overflow-hidden rounded-[calc(var(--radius-3xl)+12px)] bg-(--background) text-(--foreground) shadow-[0_0_0_0.5px_var(--separator),0_8px_32px_rgb(0_0_0/0.2)]"
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
