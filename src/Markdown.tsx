import { useEffect, useImperativeHandle, useRef, useState, type KeyboardEvent, type Ref } from "react";
import { createPortal } from "react-dom";
import { Editor, Extension, isTextSelection, type ChainedCommands } from "@tiptap/core";
import BubbleMenu from "@tiptap/extension-bubble-menu";
import Image from "@tiptap/extension-image";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Placeholder } from "@tiptap/extensions";
import { Markdown as MarkdownExtension } from "@tiptap/markdown";
import { PluginKey, type EditorState } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import Suggestion, { exitSuggestion, type SuggestionProps } from "@tiptap/suggestion";
import Icon, { type IconName } from "./Icon.tsx";
import { Details, DetailsContent, DetailsSummary } from "./details.ts";
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
  /** Asks for an image to insert once applied. */
  picksImage?: boolean;
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
  { title: "Toggle", icon: "chevronRight", aliases: "details collapse", apply: (c) => c.setDetails(), is: ["detailsSummary"] },
  { title: "Quote", icon: "quote", aliases: "blockquote", apply: (c) => c.setBlockquote(), is: ["blockquote"] },
  { title: "Code Block", icon: "codeBlock", aliases: "pre", apply: (c) => c.setCodeBlock(), is: ["codeBlock"] },
  { title: "Divider", icon: "divider", aliases: "hr rule line", apply: (c) => c.setHorizontalRule() },
  { title: "Image", icon: "photo", aliases: "picture photo", apply: (c) => c, picksImage: true },
];
const turnIntoBlocks = blocks.filter((b) => b.is);
const slashKey = new PluginKey("slash");
const bubbleKey = new PluginKey("bubbleMenu");

/** The open slash menu, placed under the "/" or above it near the bottom of the window. */
type Slash = { items: Block[]; index: number; x: number; y: number; above: boolean; run: (block: Block) => void };

export interface MarkdownHandle {
  undo: () => void;
  redo: () => void;
}

const preventMouseDown = (event: { preventDefault: () => void }) => event.preventDefault();

export default function Markdown({
  ref,
  value,
  onchange,
  editable = true,
  autofocus = false,
  placeholder = "Type / for commands",
  className = "",
  onerror,
}: {
  ref?: Ref<MarkdownHandle>;
  /** The initial markdown; later changes to it are ignored. */
  value: string;
  onchange?: (markdown: string) => void;
  editable?: boolean;
  autofocus?: boolean;
  placeholder?: string;
  className?: string;
  onerror: (error: unknown) => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  // Created outside React, as the bubble menu plugin moves it in and out of the editor.
  const [bubble] = useState(() => Object.assign(document.createElement("div"), { className: "bubble-menu" }));
  const slashMenu = useRef<HTMLDivElement>(null);
  const [slash, setSlashState] = useState<Slash | null>(null);
  const slashRef = useRef(slash);
  const setSlash = (next: Slash | null) => {
    slashRef.current = next;
    setSlashState(next);
  };
  /** The toolbar's open dropdown. */
  const [toolbarMenu, setToolbarMenu] = useState<"turnInto" | "link" | null>(null);
  const [linkHref, setLinkHref] = useState("");
  /** True while the mouse is selecting text; the toolbar waits until it is released, like Notion's. */
  const selecting = useRef(false);
  const [editor, setEditor] = useState<Editor | null>(null);
  const editorRef = useRef<Editor | null>(null);
  /** Bumped on every change so the popup's pressed states follow the selection. */
  const [, setRevision] = useState(0);
  // The editor's callbacks are set up once, so they reach the latest props through refs.
  const latest = useRef({ onchange, onerror });
  latest.current = { onchange, onerror };

  useEffect(() => {
    const instance = new Editor({
      element: element.current!,
      editable,
      autofocus,
      extensions: [
        // Markdown has no underline, so it would be lost on save.
        StarterKit.configure({ underline: false, link: { openOnClick: false } }),
        TaskList,
        TaskItem.configure({ nested: true }),
        Image.configure({ allowBase64: true }),
        Details,
        DetailsSummary,
        DetailsContent,
        MarkdownExtension,
        Placeholder.configure({
          includeChildren: true,
          placeholder: ({ node }) =>
            node.type.name === "heading" ? `Heading ${node.attrs.level}` : node.type.name === "detailsSummary" ? "Toggle" : placeholder,
        }),
        BubbleMenu.configure({
          element: bubble,
          pluginKey: bubbleKey,
          updateDelay: 0,
          shouldShow: ({ view, state }) => (view.hasFocus() || bubble.contains(document.activeElement)) && canShowToolbar(state),
          options: { placement: "top-start", onHide: () => setToolbarMenu(null) },
        }),
        SlashCommand,
        Extension.create({
          name: "linkShortcut",
          addKeyboardShortcuts: () => ({ "Mod-k": () => openLink() }),
        }),
      ],
      content: value,
      contentType: "markdown",
      onTransaction: () => setRevision((n) => n + 1),
      onUpdate: ({ editor }) => latest.current.onchange?.(editor.getMarkdown()),
    });
    editorRef.current = instance;
    setEditor(instance);
    return () => {
      instance.destroy();
      editorRef.current = null;
    };
  }, []);

  useImperativeHandle(ref, () => ({
    undo: () => editorRef.current?.commands.undo(),
    redo: () => editorRef.current?.commands.redo(),
  }));

  useEffect(() => {
    const showToolbarAfterSelecting = () => {
      if (!selecting.current) return;
      selecting.current = false;
      if (editorRef.current && canShowToolbar(editorRef.current.state)) showToolbar();
    };
    window.addEventListener("mouseup", showToolbarAfterSelecting);
    return () => window.removeEventListener("mouseup", showToolbarAfterSelecting);
  }, []);

  useEffect(() => {
    slashMenu.current?.querySelector(".selected")?.scrollIntoView({ block: "nearest" });
  }, [slash?.index]);

  const active = (name: string, attributes?: Record<string, unknown>) => editor?.isActive(name, attributes) ?? false;

  // Text selections only, so selecting an image or code doesn't offer text formatting.
  function canShowToolbar(state: EditorState) {
    const { selection, doc } = state;
    return (
      editable &&
      !selecting.current &&
      isTextSelection(selection) &&
      !!doc.textBetween(selection.from, selection.to).length &&
      !selection.$from.parent.type.spec.code
    );
  }

  function showToolbar() {
    const editor = editorRef.current;
    if (!editor) return;
    // "show" positions the menu before it is visible, which the plugin skips, so it is placed again after.
    editor.view.dispatch(editor.state.tr.setMeta(bubbleKey, "show"));
    editor.view.dispatch(editor.state.tr.setMeta(bubbleKey, "updatePosition"));
  }

  /** The type of the block holding the selection; lists and quotes win over the paragraphs inside them. */
  const currentBlock = turnIntoBlocks.slice(1).find((b) => b.is && editor?.isActive(...b.is)) ?? turnIntoBlocks[0];

  function turnInto(block: Block) {
    setToolbarMenu(null);
    if (!editor || block === currentBlock) return;
    // Clearing first takes the block out of any list, quote or toggle, as Notion does.
    const chain = editor.chain().focus();
    block.apply(currentBlock.is?.[0] === "detailsSummary" ? chain.unsetDetails() : chain.clearNodes()).run();
  }

  function openLink() {
    const editor = editorRef.current;
    if (!editor || !canShowToolbar(editor.state)) return false;
    setLinkHref(editor.getAttributes("link").href ?? "");
    showToolbar();
    setToolbarMenu("link");
    return true;
  }

  /** Sets the link on the selection, or removes it when the field is empty. */
  function applyLink(href: string) {
    if (!editor) return;
    const chain = editor.chain().focus().extendMarkRange("link");
    if (href.trim()) chain.setLink({ href: href.trim() }).run();
    else chain.unsetLink().run();
    setToolbarMenu(null);
  }

  function onLinkKeyDown(event: KeyboardEvent) {
    if (event.key === "Enter") applyLink(linkHref);
    else if (event.key === "Escape") {
      setToolbarMenu(null);
      editor?.commands.focus();
    } else return;
    event.preventDefault();
  }

  function showSlash(props: SuggestionProps<Block, Block>) {
    const rect = props.clientRect?.();
    if (!rect || !props.items.length) {
      setSlash(null);
      return;
    }
    const above = rect.bottom + 320 > window.innerHeight;
    setSlash({
      items: props.items,
      index: 0,
      x: rect.left,
      y: above ? window.innerHeight - rect.top + 6 : rect.bottom + 6,
      above,
      run: props.command,
    });
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
            if (props.picksImage) insertImage();
          },
          render: () => ({
            onStart: showSlash,
            onUpdate: showSlash,
            onExit: () => setSlash(null),
            onKeyDown: ({ event, view }) => {
              const slash = slashRef.current;
              if (!slash) return false;
              const { items, index } = slash;
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                const step = event.key === "ArrowDown" ? 1 : -1;
                setSlash({ ...slash, index: (index + step + items.length) % items.length });
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

  async function insertImage() {
    const file = await pickImage();
    if (!file) return;
    try {
      const { src } = await shrinkImage(file);
      editorRef.current?.chain().focus().setImage({ src }).run();
    } catch {
      latest.current.onerror(new Error("This image could not be opened."));
    }
  }

  // Keeps the selection while clicking.
  const button = (name: IconName, title: string, onClick: () => void, pressed: boolean) => (
    <button
      className={`icon-button ${pressed ? "active" : ""}`}
      title={title}
      aria-label={title}
      aria-pressed={pressed}
      onMouseDown={preventMouseDown}
      onClick={onClick}
    >
      <Icon name={name} />
    </button>
  );

  const menuItem = (block: Block, selected: boolean, onClick: () => void, onHover?: () => void, checked = false) => (
    <button
      key={block.title}
      role="option"
      aria-selected={selected}
      className={selected ? "selected" : undefined}
      onMouseDown={preventMouseDown}
      onMouseMove={onHover}
      onClick={onClick}
    >
      <span className="block-icon">
        <Icon name={block.icon} size={18} />
      </span>
      {block.title}
      {checked && (
        <span className="check">
          <Icon name="check" size={16} />
        </span>
      )}
    </button>
  );

  return (
    <>
      <div
        className={className}
        ref={element}
        onMouseDown={(event) => (selecting.current = !!editor?.view.dom.contains(event.target as Node))}
      ></div>

      {createPortal(
        <>
          <button
            className="turn-into"
            title="Turn Into"
            aria-expanded={toolbarMenu === "turnInto"}
            onMouseDown={preventMouseDown}
            onClick={() => setToolbarMenu(toolbarMenu === "turnInto" ? null : "turnInto")}
          >
            {currentBlock.title}
            <span className="chevron-down">
              <Icon name="chevronRight" size={12} />
            </span>
          </button>
          <div className="toolbar-separator"></div>
          {button("link", "Link", () => (toolbarMenu === "link" ? setToolbarMenu(null) : openLink()), active("link"))}
          <div className="toolbar-separator"></div>
          {button("bold", "Bold", () => editor?.chain().focus().toggleBold().run(), active("bold"))}
          {button("italic", "Italic", () => editor?.chain().focus().toggleItalic().run(), active("italic"))}
          {button("strike", "Strikethrough", () => editor?.chain().focus().toggleStrike().run(), active("strike"))}
          {button("code", "Code", () => editor?.chain().focus().toggleCode().run(), active("code"))}

          {toolbarMenu === "turnInto" ? (
            <div className="slash-menu toolbar-dropdown" role="listbox">
              {turnIntoBlocks.map((block) => menuItem(block, false, () => turnInto(block), undefined, block === currentBlock))}
            </div>
          ) : (
            toolbarMenu === "link" && (
              <div className="slash-menu toolbar-dropdown link-editor">
                <input placeholder="Paste link" value={linkHref} onChange={(e) => setLinkHref(e.target.value)} onKeyDown={onLinkKeyDown} autoFocus />
                {active("link") && (
                  <button onMouseDown={preventMouseDown} onClick={() => applyLink("")}>
                    Remove Link
                  </button>
                )}
              </div>
            )
          )}
        </>,
        bubble,
      )}

      {slash && (
        <div
          className="slash-menu"
          role="listbox"
          ref={slashMenu}
          style={{ left: slash.x, top: slash.above ? undefined : slash.y, bottom: slash.above ? slash.y : undefined }}
        >
          {slash.items.map((block, i) =>
            menuItem(
              block,
              i === slash.index,
              () => slash.run(block),
              () => i !== slash.index && setSlash({ ...slash, index: i }),
            ),
          )}
        </div>
      )}
    </>
  );
}
