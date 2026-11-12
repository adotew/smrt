<script lang="ts">
  import { onMount } from "svelte";
  import type { Account } from "../electron/assistant.ts";
  import type { Theme } from "../electron/main.ts";
  import { Button } from "$lib/components/ui/button";
  import * as ToggleGroup from "$lib/components/ui/toggle-group";

  const api = window.smrt;
  let theme = $state<Theme | null>(null);
  let account = $state<Account | null>(null);
  let signingIn = $state(false);
  let code = $state("");
  let error = $state("");

  onMount(async () => {
    theme = await api.readTheme();
    account = await api.readAccount();
  });

  async function signIn() {
    signingIn = true;
    error = "";
    try {
      await api.signIn();
      account = await api.readAccount();
    } catch (e) {
      error = e instanceof Error ? e.message.replace(/^Error invoking remote method '\w+': (Error: )?/, "") : String(e);
    }
    signingIn = false;
    code = "";
  }
</script>

<main class="flex flex-1 flex-col justify-center gap-5 px-8 text-(--foreground)">
  <div class="flex items-center justify-between gap-6">
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
  </div>
  <div class="flex items-center justify-between gap-6">
    <span>Claude</span>
    {#if account?.loggedIn}
      <span class="truncate text-sm text-muted-foreground">
        {account.email}{account.subscriptionType ? ` · ${account.subscriptionType[0].toUpperCase()}${account.subscriptionType.slice(1)}` : ""}
      </span>
    {:else if account}
      <Button size="sm" onclick={signIn} disabled={signingIn}>{signingIn ? "Waiting for Browser…" : "Sign In"}</Button>
    {/if}
  </div>
  {#if signingIn}
    <form
      class="flex gap-2"
      onsubmit={(event) => {
        event.preventDefault();
        api.enterSignInCode(code);
      }}
    >
      <input bind:value={code} placeholder="Paste the code from your browser" class="min-w-0 flex-1 rounded-md border px-2 py-1 text-sm" />
      <Button type="submit" size="sm" variant="outline" disabled={!code.trim()}>Enter</Button>
    </form>
  {:else if error}
    <p class="m-0 text-sm text-destructive">{error}</p>
  {/if}
</main>
