<script lang="ts">
  import type { Snippet } from "svelte";
  import Deck from "./Deck.svelte";
  import type { IconName } from "./Icon.svelte";
  import MarkdownEditor from "./MarkdownEditor.svelte";
  import Reader from "./Reader.svelte";

  let {
    path,
    active,
    inset,
    onerror,
    iconButton,
  }: {
    path: string | null;
    /** The pane the sidebar and menu commands act on. */
    active: boolean;
    /** Width on the left covered by the floating sidebar. */
    inset: number;
    onerror: (error: unknown) => void;
    iconButton: Snippet<[IconName, string, () => void, boolean?, boolean?]>;
  } = $props();

  let showingNotes = $state(false);
  let placingNote = $state(false);
  let reader: Reader | undefined = $state();
  let markdown: MarkdownEditor | undefined = $state();
  let deck: Deck | undefined = $state();

  const fileType = (path: string) => (/\.md$/i.test(path) ? "md" : /\.cards$/i.test(path) ? "cards" : "pdf");
  const markdownPath = $derived(path && fileType(path) === "md" ? path : null);
  const deckPath = $derived(path && fileType(path) === "cards" ? path : null);
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

<Reader bind:this={reader} path={pdfPath} {showingNotes} bind:placingNote {inset} {onerror} />
{#if markdownPath}
  {#key markdownPath}
    <MarkdownEditor bind:this={markdown} path={markdownPath} {inset} {onerror} />
  {/key}
{:else if deckPath}
  {#key deckPath}
    <Deck bind:this={deck} path={deckPath} {active} {inset} {onerror} />
  {/key}
{:else if pdfPath}
  <div class="bottom-toolbar floating" style:--inset="{inset}px">
    {@render iconButton("notes", "Notes", toggleNotes, false, showingNotes)}
    {@render iconButton("pageNote", "Add Note to Page", () => (placingNote = !placingNote), false, placingNote)}
    {@render iconButton("photo", "Add Image to Page", () => reader?.insertImage())}
  </div>
{/if}
