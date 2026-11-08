<script lang="ts">
  let { path, inset = 0 }: { path: string; inset?: number } = $props();

  // Served by the smrt-file protocol in main.ts, so the page's relative links resolve within the library.
  const src = $derived(`smrt-file://library/${path.split(/[\\/]/).filter(Boolean).map(encodeURIComponent).join("/")}`);
</script>

<div class="markdown" style:padding-left="{inset}px">
  <!-- Without allow-same-origin the page can't reach window.smrt in the app. -->
  <iframe class="html-page" title={path.split(/[\\/]/).pop()} sandbox="allow-scripts allow-forms allow-popups allow-modals" {src}></iframe>
</div>
