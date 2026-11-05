<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { Editor, Extension, isTextSelection, type ChainedCommands } from "@tiptap/core";
  import BubbleMenu from "@tiptap/extension-bubble-menu";
  import Image from "@tiptap/extension-image";
  import { TaskItem, TaskList } from "@tiptap/extension-list";
  import { Placeholder } from "@tiptap/extensions";
  import { Markdown } from "@tiptap/markdown";
  import { PluginKey, type EditorState } from "@tiptap/pm/state";
  import StarterKit from "@tiptap/starter-kit";
  import Suggestion, { exitSuggestion, type SuggestionProps } from "@tiptap/suggestion";
  import Icon, { type IconName } from "./Icon.svelte";
  import { pickImage, shrinkImage } from "./image.ts";

  /** A block type offered by the slash menu and, with `is`, by the toolbar's Turn Into menu. */
  interface Block {
    title: string;
    icon: IconName;
    /** Extra words the slash menu matches. */
    aliases: string;
    apply: (chain: ChainedCommands) => ChainedCommands;
    /** The node and attributes that mark a block of this type. */
    is?: [name: string, attributes?: Record<string, unknown>];
    after?: () => void;
  }

  const blocks: Block[] = [
    { title: "Text", icon: "text", aliases: "paragraph", apply: (c) => c.setParagraph(), is: ["paragraph"] },
    ...([1, 2, 3] as const).map((level) => ({
      title: `Heading ${level}`,
      icon: `heading${level}` as const,
      aliases: `h${level} title`,
      apply: (c: ChainedCommands) => c.setHeading({ level }),
      is: ["heading", { level }] as Block["is"],
    })),
    { title: "Bulleted List", icon: "list", aliases: "ul unordered", apply: (c) => c.toggleBulletList(), is: ["bulletList"] },
    { title: "Numbered List", icon: "numberedList", aliases: "ol ordered", apply: (c) => c.toggleOrderedList(), is: ["orderedList"] },
    { title: "Checklist", icon: "checklist", aliases: "todo task", apply: (c) => c.toggleTaskList(), is: ["taskList"] },
    { title: "Quote", icon: "quote", aliases: "blockquote", apply: (c) => c.setBlockquote(), is: ["blockquote"] },
    { title: "Code Block", icon: "codeBlock", aliases: "pre", apply: (c) => c.setCodeBlock(), is: ["codeBlock"] },
    { title: "Divider", icon: "divider", aliases: "hr rule line", apply: (c) => c.setHorizontalRule() },
    { title: "Image", icon: "photo", aliases: "picture photo", apply: (c) => c, after: () => insertImage() },
  ];
  const turnIntoBlocks = blocks.filter((b) => b.is);
  const slashKey = new PluginKey("slash");
  const bubbleKey = new PluginKey("bubbleMenu");

  let {
    value,
    onchange,
    editable = true,
    autofocus = false,
    placeholder = "Type / for commands",
    class: className = "",
    onerror,
  }: {
    /** The initial markdown; later changes to it are ignored. */
    value: string;
    onchange?: (markdown: string) => void;
    editable?: boolean;
    autofocus?: boolean;
    placeholder?: string;
    class?: string;
    onerror: (error: unknown) => void;
  } = $props();

  let element: HTMLElement;
  let bubble: HTMLElement;
  let slashMenu: HTMLElement | undefined = $state();
  /** The open slash menu, placed under the "/" or above it near the bottom of the window. */
  let slash: { items: Block[]; index: number; x: number; y: number; above: boolean; run: (block: Block) => void } | null =
    $state.raw(null);
  /** The toolbar's open dropdown. */
  let toolbarMenu: "turnInto" | "link" | null = $state(null);
  let linkHref = $state("");
  /** True while the mouse is selecting text; the toolbar waits until it is released, like Notion's. */
  let selecting = false;
  let editor: Editor | null = $state.raw(null);
  /** Bumped on every change so the popup's pressed states follow the selection. */
  let revision = $state(0);

  onMount(() => {
    editor = new Editor({
      element,
      editable,
      autofocus,
      extensions: [
        // Markdown has no underline, so it would be lost on save.
        StarterKit.configure({ underline: false, link: { openOnClick: false } }),
        TaskList,
        TaskItem.configure({ nested: true }),
        Image.configure({ allowBase64: true }),
        Markdown,
        Placeholder.configure({
          placeholder: ({ node }) => (node.type.name === "heading" ? `Heading ${node.attrs.level}` : placeholder),
        }),
        BubbleMenu.configure({
          element: bubble,
          pluginKey: bubbleKey,
          updateDelay: 0,
          shouldShow: ({ view, state }) => (view.hasFocus() || bubble.contains(document.activeElement)) && canShowToolbar(state),
          options: { placement: "top-start", onHide: () => (toolbarMenu = null) },
        }),
        SlashCommand,
        Extension.create({
          name: "linkShortcut",
          addKeyboardShortcuts: () => ({ "Mod-k": () => openLink() }),
        }),
      ],
      content: value,
      contentType: "markdown",
      onTransaction: () => revision++,
      onUpdate: ({ editor }) => onchange?.(editor.getMarkdown()),
    });
  });

  onDestroy(() => editor?.destroy());

  export const undo = () => editor?.commands.undo();
  export const redo = () => editor?.commands.redo();

  function active(name: string, attributes?: Record<string, unknown>) {
    void revision;
    return editor?.isActive(name, attributes) ?? false;
  }

  // Text selections only, so selecting an image or code doesn't offer text formatting.
  function canShowToolbar(state: EditorState) {
    const { selection, doc } = state;
    return (
      editable &&
      !selecting &&
      isTextSelection(selection) &&
      !!doc.textBetween(selection.from, selection.to).length &&
      !selection.$from.parent.type.spec.code
    );
  }

  function showToolbar() {
    if (!editor) return;
    // "show" positions the menu before it is visible, which the plugin skips, so it is placed again after.
    editor.view.dispatch(editor.state.tr.setMeta(bubbleKey, "show"));
    editor.view.dispatch(editor.state.tr.setMeta(bubbleKey, "updatePosition"));
  }

  function showToolbarAfterSelecting() {
    if (!selecting) return;
    selecting = false;
    if (editor && canShowToolbar(editor.state)) showToolbar();
  }

  /** The type of the block holding the selection; lists and quotes win over the paragraphs inside them. */
  const currentBlock = $derived.by(() => {
    void revision;
    return turnIntoBlocks.slice(1).find((b) => b.is && editor?.isActive(...b.is)) ?? turnIntoBlocks[0];
  });

  function turnInto(block: Block) {
    toolbarMenu = null;
    if (!editor || block === currentBlock) return;
    // Clearing first takes the block out of any list or quote, as Notion does.
    block.apply(editor.chain().focus().clearNodes()).run();
  }

  function openLink() {
    if (!editor || !canShowToolbar(editor.state)) return false;
    linkHref = editor.getAttributes("link").href ?? "";
    showToolbar();
    toolbarMenu = "link";
    return true;
  }

  /** Sets the link on the selection, or removes it when the field is empty. */
  function applyLink(href: string) {
    if (!editor) return;
    const chain = editor.chain().focus().extendMarkRange("link");
    if (href.trim()) chain.setLink({ href: href.trim() }).run();
    else chain.unsetLink().run();
    toolbarMenu = null;
  }

  function onLinkKeydown(event: KeyboardEvent) {
    if (event.key === "Enter") applyLink(linkHref);
    else if (event.key === "Escape") {
      toolbarMenu = null;
      editor?.commands.focus();
    } else return;
    event.preventDefault();
  }

  function showSlash(props: SuggestionProps<Block, Block>) {
    const rect = props.clientRect?.();
    if (!rect || !props.items.length) {
      slash = null;
      return;
    }
    const above = rect.bottom + 320 > window.innerHeight;
    slash = {
      items: props.items,
      index: 0,
      x: rect.left,
      y: above ? window.innerHeight - rect.top + 6 : rect.bottom + 6,
      above,
      run: props.command,
    };
  }

  const SlashCommand = Extension.create({
    name: "slashCommand",
    addProseMirrorPlugins() {
      return [
        Suggestion<Block, Block>({
          editor: this.editor,
          pluginKey: slashKey,
          char: "/",
          // Code keeps its slashes.
          allow: ({ state, range }) => !state.doc.resolve(range.from).parent.type.spec.code,
          items: ({ query }) => blocks.filter((b) => `${b.title} ${b.aliases}`.toLowerCase().includes(query.toLowerCase())),
          command: ({ editor, range, props }) => {
            props.apply(editor.chain().focus().deleteRange(range)).run();
            props.after?.();
          },
          render: () => ({
            onStart: showSlash,
            onUpdate: showSlash,
            onExit: () => (slash = null),
            onKeyDown: ({ event, view }) => {
              if (!slash) return false;
              const { items, index } = slash;
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                const step = event.key === "ArrowDown" ? 1 : -1;
                slash = { ...slash, index: (index + step + items.length) % items.length };
              } else if (event.key === "Enter" || event.key === "Tab") {
                slash.run(items[index]);
              } else if (event.key === "Escape") {
                exitSuggestion(view, slashKey);
              } else {
                return false;
              }
              return true;
            },
          }),
        }),
      ];
    },
  });

  $effect(() => {
    void slash?.index;
    slashMenu?.querySelector(".selected")?.scrollIntoView({ block: "nearest" });
  });

  async function insertImage() {
    const file = await pickImage();
    if (!file) return;
    try {
      const { src } = await shrinkImage(file);
      editor?.chain().focus().setImage({ src }).run();
    } catch {
      onerror(new Error("This image could not be opened."));
    }
  }
</script>

<svelte:window onmouseup={showToolbarAfterSelecting} />

{#snippet button(name: IconName, title: string, onclick: () => void, pressed: boolean)}
  <!-- Keeps the selection while clicking. -->
  <button
    class="icon-button"
    class:active={pressed}
    {title}
    aria-label={title}
    aria-pressed={pressed}
    onmousedown={(event) => event.preventDefault()}
    {onclick}
  >
    <Icon {name} />
  </button>
{/snippet}

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class={className}
  bind:this={element}
  onmousedown={(event) => (selecting = !!editor?.view.dom.contains(event.target as Node))}
></div>

{#snippet menuItem(block: Block, selected: boolean, onclick: () => void, onhover?: () => void, checked = false)}
  <button
    role="option"
    aria-selected={selected}
    class:selected
    onmousedown={(event) => event.preventDefault()}
    onmousemove={onhover}
    {onclick}
  >
    <span class="block-icon"><Icon name={block.icon} size={18} /></span>
    {block.title}
    {#if checked}<span class="check"><Icon name="check" size={16} /></span>{/if}
  </button>
{/snippet}

<div class="bubble-menu" bind:this={bubble}>
  <button
    class="turn-into"
    title="Turn Into"
    aria-expanded={toolbarMenu === "turnInto"}
    onmousedown={(event) => event.preventDefault()}
    onclick={() => (toolbarMenu = toolbarMenu === "turnInto" ? null : "turnInto")}
  >
    {currentBlock.title}
    <span class="chevron-down"><Icon name="chevronRight" size={12} /></span>
  </button>
  <div class="toolbar-separator"></div>
  {@render button("link", "Link", () => (toolbarMenu === "link" ? (toolbarMenu = null) : openLink()), active("link"))}
  <div class="toolbar-separator"></div>
  {@render button("bold", "Bold", () => editor?.chain().focus().toggleBold().run(), active("bold"))}
  {@render button("italic", "Italic", () => editor?.chain().focus().toggleItalic().run(), active("italic"))}
  {@render button("strike", "Strikethrough", () => editor?.chain().focus().toggleStrike().run(), active("strike"))}
  {@render button("code", "Code", () => editor?.chain().focus().toggleCode().run(), active("code"))}

  {#if toolbarMenu === "turnInto"}
    <div class="slash-menu toolbar-dropdown" role="listbox">
      {#each turnIntoBlocks as block (block.title)}
        {@render menuItem(block, false, () => turnInto(block), undefined, block === currentBlock)}
      {/each}
    </div>
  {:else if toolbarMenu === "link"}
    <div class="slash-menu toolbar-dropdown link-editor">
      <input
        placeholder="Paste link"
        bind:value={linkHref}
        onkeydown={onLinkKeydown}
        {@attach (input) => input.focus()}
      />
      {#if active("link")}
        <button onmousedown={(event) => event.preventDefault()} onclick={() => applyLink("")}>Remove Link</button>
      {/if}
    </div>
  {/if}
</div>

{#if slash}
  <div
    class="slash-menu"
    role="listbox"
    bind:this={slashMenu}
    style:left="{slash.x}px"
    style:top={slash.above ? null : `${slash.y}px`}
    style:bottom={slash.above ? `${slash.y}px` : null}
  >
    {#each slash.items as block, i (block.title)}
      {@render menuItem(
        block,
        i === slash.index,
        () => slash?.run(block),
        () => slash && i !== slash.index && (slash = { ...slash, index: i }),
      )}
    {/each}
  </div>
{/if}
