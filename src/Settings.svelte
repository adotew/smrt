<script lang="ts">
  import { onMount } from "svelte";
  import type { Theme } from "../electron/main.ts";
  import * as ToggleGroup from "$lib/components/ui/toggle-group";

  const api = window.smrt;
  let theme = $state<Theme | null>(null);

  onMount(async () => (theme = await api.readTheme()));
</script>

<main class="flex flex-1 items-center justify-between gap-6 px-8 text-(--foreground)">
  <span>Appearance</span>
  {#if theme}
    <ToggleGroup.Root
      type="single"
      variant="outline"
      size="sm"
      value={theme}
      onValueChange={(value) => value && api.setTheme((theme = value as Theme))}
    >
      <ToggleGroup.Item value="system">System</ToggleGroup.Item>
      <ToggleGroup.Item value="light">Light</ToggleGroup.Item>
      <ToggleGroup.Item value="dark">Dark</ToggleGroup.Item>
    </ToggleGroup.Root>
  {/if}
</main>
