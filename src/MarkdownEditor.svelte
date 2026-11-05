<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import Markdown from "./Markdown.svelte";

  const api = window.smrt;

  let {
    path,
    inset = 0,
    onerror,
  }: {
    path: string;
    /** Width on the left covered by the floating sidebar. */
    inset?: number;
    onerror: (error: unknown) => void;
  } = $props();

  /** Null until the file has loaded, so a file that failed to load is never overwritten. */
  let text: string | null = $state(null);
  let editor: Markdown | undefined = $state();
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Saves run one after another so an older one never lands last. */
  let saving: Promise<void> = Promise.resolve();

  onMount(async () => {
    try {
      text = await api.readMarkdown(path);
    } catch (error) {
      onerror(error);
    }
  });

  onDestroy(() => flush());

  function save() {
    clearTimeout(timer);
    timer = undefined;
    if (text == null) return;
    const latest = text;
    saving = saving.then(() => api.saveMarkdown(path, latest)).catch(onerror);
  }

  /** Saves pending edits and resolves once every save has finished. */
  export function flush() {
    if (timer) save();
    return saving;
  }

  export const undo = () => editor?.undo();
  export const redo = () => editor?.redo();
</script>

<svelte:window onbeforeunload={flush} />

<div class="markdown" style:padding-left="{inset}px">
  {#if text != null}
    <Markdown
      bind:this={editor}
      class="markdown-content"
      value={text}
      onchange={(markdown) => {
        text = markdown;
        clearTimeout(timer);
        timer = setTimeout(save, 400);
      }}
      {onerror}
    />
  {/if}
</div>
