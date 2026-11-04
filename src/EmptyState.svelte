<script>
  import Icon from "./Icon.svelte";

  let { icon, title, description = null, action = null } = $props();
</script>

<div class="empty">
  <Icon name={icon} size={52} />
  <h3>{title}</h3>
  {#if description}<p>{description}</p>{/if}
  {#if action}<button onclick={action.run}>{action.label}</button>{/if}
</div>
