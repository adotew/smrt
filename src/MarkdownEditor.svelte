<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { Editor } from "@tiptap/core";
  import Image from "@tiptap/extension-image";
  import { TaskItem, TaskList } from "@tiptap/extension-list";
  import { Markdown } from "@tiptap/markdown";
  import StarterKit from "@tiptap/starter-kit";
  import Icon, { type IconName } from "./Icon.svelte";
  import { pickImage, shrinkImage } from "./image.ts";

  const api = window.smrt;

  let {
    path,
    inset = 0,
    onerror,
    ask,
  }: {
    path: string;
    /** Width on the left covered by the floating sidebar. */
    inset?: number;
    onerror: (error: unknown) => void;
    ask: (title: string, confirm: string, value?: string) => Promise<string | null>;
  } = $props();

  let element: HTMLElement;
  /** Null until the file has loaded, so a file that failed to load is never overwritten. */
  let editor: Editor | null = $state.raw(null);
  /** Bumped on every change so the toolbar's pressed states follow the selection. */
  let revision = $state(0);
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Saves run one after another so an older one never lands last. */
  let saving: Promise<void> = Promise.resolve();
  let destroyed = false;

  onMount(async () => {
    let text: string;
    try {
      text = await api.readMarkdown(path);
    } catch (error) {
      return onerror(error);
    }
    if (destroyed) return;
    editor = new Editor({
      element,
      extensions: [
        // Markdown has no underline, so it would be lost on save.
        StarterKit.configure({ underline: false, link: { openOnClick: false } }),
        TaskList,
        TaskItem.configure({ nested: true }),
        Image.configure({ allowBase64: true }),
        Markdown,
      ],
      content: text,
      contentType: "markdown",
      onTransaction: () => revision++,
      onUpdate: () => {
        clearTimeout(timer);
        timer = setTimeout(save, 400);
      },
    });
  });

  onDestroy(() => {
    destroyed = true;
    flush();
    editor?.destroy();
  });

  function save() {
    clearTimeout(timer);
    timer = undefined;
    if (!editor) return;
    const text = editor.getMarkdown();
    saving = saving.then(() => api.saveMarkdown(path, text)).catch(onerror);
  }

  /** Saves pending edits and resolves once every save has finished. */
  export function flush() {
    if (timer) save();
    return saving;
  }

  export const undo = () => editor?.commands.undo();
  export const redo = () => editor?.commands.redo();

  function active(name: string, attributes?: Record<string, unknown>) {
    void revision;
    return editor?.isActive(name, attributes) ?? false;
  }

  async function chooseHeading() {
    const choice = await api.contextMenu([
      { id: "0", label: "Text" },
      { id: "1", label: "Heading 1" },
      { id: "2", label: "Heading 2" },
      { id: "3", label: "Heading 3" },
    ]);
    if (!editor || choice == null) return;
    const chain = editor.chain().focus();
    if (choice === "0") chain.setParagraph().run();
    else chain.setHeading({ level: Number(choice) as 1 | 2 | 3 }).run();
  }

  async function chooseList() {
    const choice = await api.contextMenu([
      { id: "bullet", label: "Bulleted List" },
      { id: "ordered", label: "Numbered List" },
      { id: "task", label: "Checklist" },
    ]);
    const chain = editor?.chain().focus();
    if (choice === "bullet") chain?.toggleBulletList().run();
    else if (choice === "ordered") chain?.toggleOrderedList().run();
    else if (choice === "task") chain?.toggleTaskList().run();
  }

  /** Removes the link under the cursor, or asks for one to add. */
  async function toggleLink() {
    if (!editor) return;
    if (editor.isActive("link")) {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }
    const href = (await ask("Add Link", "Add", "https://"))?.trim();
    if (!href || !editor) return;
    const chain = editor.chain().focus();
    if (editor.state.selection.empty) {
      chain.insertContent({ type: "text", text: href, marks: [{ type: "link", attrs: { href } }] }).run();
    } else {
      chain.setLink({ href }).run();
    }
  }

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

<svelte:window onbeforeunload={flush} />

{#snippet button(name: IconName, title: string, onclick: () => void, pressed: boolean | undefined = undefined)}
  <button
    class="icon-button"
    class:active={pressed}
    {title}
    aria-label={title}
    aria-pressed={pressed}
    disabled={!editor}
    {onclick}
  >
    <Icon {name} />
  </button>
{/snippet}

<div class="markdown" style:padding-left="{inset}px">
  <div class="markdown-content" bind:this={element}></div>
</div>

<div id="bottom-toolbar" class="floating" style:--inset="{inset}px">
  {@render button("undo", "Undo", undo)}
  {@render button("redo", "Redo", redo)}
  <div class="toolbar-separator"></div>
  {@render button("heading", "Heading", chooseHeading, active("heading"))}
  {@render button("list", "List", chooseList, active("bulletList") || active("orderedList") || active("taskList"))}
  {@render button("quote", "Quote", () => editor?.chain().focus().toggleBlockquote().run(), active("blockquote"))}
  {@render button("codeBlock", "Code Block", () => editor?.chain().focus().toggleCodeBlock().run(), active("codeBlock"))}
  <div class="toolbar-separator"></div>
  {@render button("bold", "Bold", () => editor?.chain().focus().toggleBold().run(), active("bold"))}
  {@render button("italic", "Italic", () => editor?.chain().focus().toggleItalic().run(), active("italic"))}
  {@render button("strike", "Strikethrough", () => editor?.chain().focus().toggleStrike().run(), active("strike"))}
  {@render button("code", "Code", () => editor?.chain().focus().toggleCode().run(), active("code"))}
  {@render button("link", active("link") ? "Remove Link" : "Add Link", toggleLink, active("link"))}
  <div class="toolbar-separator"></div>
  {@render button("photo", "Add Image", insertImage)}
</div>
