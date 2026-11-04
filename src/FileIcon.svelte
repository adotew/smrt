<script lang="ts">
  let { type, size = 20 }: { type: "pdf" | "md"; size?: number } = $props();
</script>

<!-- Markdown: JetBrains IntelliJ Platform icon (Apache-2.0). PDF: Phosphor "file-pdf" (MIT), tinted to match. -->
{#if type === "pdf"}
  <svg class="file-icon pdf" viewBox="0 0 256 256" width={size} height={size} aria-hidden="true">
    <path
      d="M224,152a8,8,0,0,1-8,8H192v16h16a8,8,0,0,1,0,16H192v16a8,8,0,0,1-16,0V152a8,8,0,0,1,8-8h32A8,8,0,0,1,224,152ZM92,172a28,28,0,0,1-28,28H56v8a8,8,0,0,1-16,0V152a8,8,0,0,1,8-8H64A28,28,0,0,1,92,172Zm-16,0a12,12,0,0,0-12-12H56v24h8A12,12,0,0,0,76,172Zm88,8a36,36,0,0,1-36,36H112a8,8,0,0,1-8-8V152a8,8,0,0,1,8-8h16A36,36,0,0,1,164,180Zm-16,0a20,20,0,0,0-20-20h-8v40h8A20,20,0,0,0,148,180ZM40,112V40A16,16,0,0,1,56,24h96a8,8,0,0,1,5.66,2.34l56,56A8,8,0,0,1,216,88v24a8,8,0,0,1-16,0V96H152a8,8,0,0,1-8-8V40H56v72a8,8,0,0,1-16,0ZM160,80h28.69L160,51.31Z"
    />
  </svg>
{:else}
  <svg class="file-icon md" viewBox="0 0 16 16" width={size} height={size} aria-hidden="true">
    <path
      fill-rule="evenodd"
      clip-rule="evenodd"
      d="M12.5929 9.9438L12.5929 4.70001L13.7929 4.70002L13.7929 9.94379L15.0763 8.66037L15.9248 9.5089L13.1929 12.2409L10.4609 9.5089L11.3095 8.66037L12.5929 9.9438Z"
    />
    <path
      d="M0.5 4.70001H2.94558L4.65385 9.14463L4.76288 9.60155L4.85635 9.14463L6.51269 4.70001H8.98423V11.9692H7.14096V7.59732L7.17212 7.12482L5.34442 11.9692H4.08269L2.31212 7.17155L2.34327 7.59732V11.9692H0.5V4.70001Z"
    />
  </svg>
{/if}

<style>
  .file-icon {
    flex: none;
    fill: var(--icon-color);
  }
  .pdf {
    --icon-color: #db5c5c;
  }
  .md {
    --icon-color: #3574f0;
  }
  @media (prefers-color-scheme: dark) {
    .pdf {
      --icon-color: #e55765;
    }
    .md {
      --icon-color: #548af7;
    }
  }
</style>
