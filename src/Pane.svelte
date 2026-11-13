<script lang="ts">
  import type { Snippet } from "svelte";
  import Assistant from "./Assistant.svelte";
  import { assistant } from "./assistant.svelte.ts";
  import { cubicOut } from "svelte/easing";
  import { scale } from "svelte/transition";
  import Deck from "./Deck.svelte";
  import Html from "./Html.svelte";
  import type { IconName } from "./Icon.svelte";
  import MarkdownEditor from "./MarkdownEditor.svelte";
  import QuizFile from "./QuizFile.svelte";
  import Reader from "./Reader.svelte";

  let {
    path,
    active,
    inset,
    context,
    docked,
    onerror,
    onopen,
    onpin,
    iconButton,
  }: {
    path: string | null;
    /** The file the assistant looks at: this pane's, or the one beside an empty pane. */
    context: string | null;
    /** Whether an open file gets the floating assistant; off while the chat has a pane of its own. */
    docked: boolean;
    /** The pane the sidebar and menu commands act on. */
    active: boolean;
    /** Width on the left covered by the floating sidebar. */
    inset: number;
    onerror: (error: unknown) => void;
    onopen: (path: string, beside?: boolean) => void;
    onpin: () => void;
    iconButton: Snippet<[IconName, string, () => void, boolean?, boolean?]>;
  } = $props();

  let showingNotes = $state(false);
  let placingNote = $state(false);
  let editingText = $state(false);
  let reader: Reader | undefined = $state();
  let markdown: MarkdownEditor | undefined = $state();
  let deck: Deck | undefined = $state();

  const fileType = (path: string) =>
    /\.md$/i.test(path) ? "md" : /\.cards$/i.test(path) ? "cards" : /\.quiz$/i.test(path) ? "quiz" : /\.html$/i.test(path) ? "html" : "pdf";
  const markdownPath = $derived(path && fileType(path) === "md" ? path : null);
  const deckPath = $derived(path && fileType(path) === "cards" ? path : null);
  const quizPath = $derived(path && fileType(path) === "quiz" ? path : null);
  const htmlPath = $derived(path && fileType(path) === "html" ? path : null);
  const pdfPath = $derived(path && fileType(path) === "pdf" ? path : null);

  /** Lets pending markdown and deck saves land before their file moves. */
  export const flush = () => Promise.all([markdown?.flush(), deck?.flush()]);
  export const toggleNotes = () => (showingNotes = !showingNotes);
  export const zoomIn = () => reader?.zoomIn();
  export const zoomOut = () => reader?.zoomOut();
  export const zoom = (scale: number | null) => reader?.zoom(scale);
  export const undo = () => (markdownPath ? markdown?.undo() : reader?.undo());
  export const redo = () => (markdownPath ? markdown?.redo() : reader?.redo());
  export const startEditing = () => deck?.startEditing();
</script>

<Reader bind:this={reader} path={pdfPath} {showingNotes} bind:placingNote bind:editingText {inset} {onerror} />
{#if markdownPath}
  <!-- Reloads once the assistant writes the file. -->
  {#key `${markdownPath}#${assistant.edits[markdownPath] ?? 0}`}
    <MarkdownEditor bind:this={markdown} path={markdownPath} {inset} {onerror} />
  {/key}
{:else if deckPath}
  {#key `${deckPath}#${assistant.edits[deckPath] ?? 0}`}
    <Deck bind:this={deck} path={deckPath} {active} {inset} {onerror} />
  {/key}
{:else if quizPath}
  {#key `${quizPath}#${assistant.edits[quizPath] ?? 0}`}
    <QuizFile path={quizPath} {inset} {onerror} />
  {/key}
{:else if htmlPath}
  {#key `${htmlPath}#${assistant.edits[htmlPath] ?? 0}`}
    <Html path={htmlPath} {inset} />
  {/key}
{:else if pdfPath && !editingText}
  <!-- Swaps in place with the text formatting bar, which grows in the same way. -->
  <div class="bottom-toolbar floating" style:--inset="{inset}px" transition:scale={{ start: 0.9, duration: 180, easing: cubicOut }}>
    {@render iconButton("notes", "Notes", toggleNotes, false, showingNotes)}
    {@render iconButton("pageNote", "Add Note to Page", () => (placingNote = !placingNote), false, placingNote)}
    {@render iconButton("photo", "Add Image to Page", () => reader?.insertImage())}
  </div>
{/if}
{#if !path}
  <Assistant mode="page" {context} {active} {inset} {onopen} />
{:else if docked}
  <Assistant mode="dock" {context} {active} {onopen} {onpin} />
{/if}
