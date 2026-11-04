<script lang="ts">
  import Icon, { type IconName } from "./Icon.svelte";

  let {
    icon,
    title,
    description = null,
    action = null,
  }: {
    icon: IconName;
    title: string;
    description?: string | null;
    action?: { label: string; run: () => void } | null;
  } = $props();
</script>

<div class="empty">
  <Icon name={icon} size={64} />
  <h3>{title}</h3>
  {#if description}<p>{description}</p>{/if}
  {#if action}<button onclick={action.run}>{action.label}</button>{/if}
</div>
