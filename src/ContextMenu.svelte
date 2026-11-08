<script module lang="ts">
  export type MenuItem = { id: string; label: string } | { type: "separator" };

  let menu: { items: MenuItem[]; x: number; y: number; resolve: (id: string | null) => void } | null = $state(null);
  let pointer = { x: 0, y: 0 };
  window.addEventListener("pointerdown", (event) => (pointer = { x: event.clientX, y: event.clientY }), true);

  /** Shows a menu at the last pointer position; resolves with the chosen item's id, or null if dismissed. */
  export function contextMenu(items: MenuItem[]) {
    menu?.resolve(null);
    return new Promise<string | null>((resolve) => (menu = { items, ...pointer, resolve }));
  }
</script>

<script lang="ts">
  let element: HTMLElement | undefined = $state();
  let restoreFocus: HTMLElement | null = null;

  function close(id: string | null) {
    menu?.resolve(id);
    menu = null;
    restoreFocus?.focus();
  }

  function onkeydown(event: KeyboardEvent) {
    const buttons = [...element!.querySelectorAll("button")];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Escape") close(null);
    else if (event.key === "ArrowDown") buttons[(index + 1) % buttons.length].focus();
    else if (event.key === "ArrowUp") buttons.at(Math.max(index, 0) - 1)?.focus();
    else return;
    event.preventDefault();
  }

  // Keeps the menu inside the window, flipping it to the pointer's other side like native menus.
  function place(node: HTMLElement) {
    restoreFocus = document.activeElement as HTMLElement | null;
    const { width, height } = node.getBoundingClientRect();
    const { x, y } = menu!;
    node.style.left = `${Math.max(4, x + width > innerWidth ? x - width : x)}px`;
    node.style.top = `${Math.max(4, y + height > innerHeight ? y - height : y)}px`;
    node.focus();
  }
</script>

<svelte:window onblur={() => menu && close(null)} onresize={() => menu && close(null)} />

{#if menu}
  <div
    class="context-menu-backdrop"
    role="presentation"
    onpointerdown={() => close(null)}
    oncontextmenu={(event) => event.preventDefault()}
  ></div>
  <div class="context-menu" role="menu" tabindex="-1" bind:this={element} {onkeydown} {@attach place}>
    {#each menu.items as item, index (index)}
      {#if "type" in item}
        <hr />
      {:else}
        <button role="menuitem" tabindex="-1" onclick={() => close(item.id)} onpointerenter={(e) => e.currentTarget.focus()}>
          {item.label}
        </button>
      {/if}
    {/each}
  </div>
{/if}
