<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import type { Card } from "../electron/library.ts";
  import { Button } from "$lib/components/ui/button";
  import * as ToggleGroup from "$lib/components/ui/toggle-group";
  import EmptyState from "./EmptyState.svelte";
  import Icon from "./Icon.svelte";
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

  /** Null until the deck has loaded, so a deck that failed to load is never overwritten. */
  let cards = $state<Card[] | null>(null);
  /** The position of the studied card among the cards with a front. */
  let index = $state(0);
  let revealed = $state(false);
  /** Decks open in study mode. */
  let editing = $state(false);
  /** The card just added, whose front takes focus. */
  let added = $state<string | null>(null);
  /** The side each card shows while editing; missing means the front. */
  let sides = $state<Record<string, "front" | "back">>({});
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Saves run one after another so an older one never lands last. */
  let saving: Promise<void> = Promise.resolve();

  const name = $derived(path.split(/[\\/]/).pop()?.replace(/\.cards$/i, ""));
  const studyable = $derived(cards?.filter((card) => card.front.trim() || card.back.trim()) ?? []);
  const studying = $derived(studyable[index]);

  onMount(async () => {
    try {
      cards = (await api.readDeck(path)).cards;
      // The sidebar's Edit Cards may have asked for editing before the deck loaded.
      if (!editing) study();
    } catch (error) {
      onerror(error);
    }
  });

  onDestroy(() => flush());

  function save() {
    clearTimeout(timer);
    timer = undefined;
    if (!cards) return;
    const deck = { cards: $state.snapshot(cards) };
    saving = saving.then(() => api.saveDeck(path, deck)).catch(onerror);
  }

  /** Saves pending edits and resolves once every save has finished. */
  export function flush() {
    if (timer) save();
    return saving;
  }

  function edit(card: Card, side: "front" | "back", text: string) {
    card[side] = text;
    clearTimeout(timer);
    timer = setTimeout(save, 400);
  }

  function addCard() {
    if (!cards) return;
    const id = crypto.randomUUID();
    cards.push({ id, front: "", back: "" });
    added = id;
    editing = true;
    save();
  }

  function removeCard(id: string) {
    if (!cards) return;
    cards = cards.filter((card) => card.id !== id);
    save();
  }

  export function startEditing() {
    editing = true;
  }

  function study() {
    editing = false;
    index = 0;
    revealed = false;
  }

  function go(step: number) {
    const next = Math.min(Math.max(index + step, 0), studyable.length - 1);
    if (next === index) return;
    index = next;
    revealed = false;
  }

  function onkeydown(event: KeyboardEvent) {
    if (editing || !studying || event.metaKey || event.ctrlKey || event.altKey) return;
    if ((event.target as Element).closest("input, textarea, dialog")) return;
    if (event.key === " ") revealed = !revealed;
    else if (event.key === "ArrowRight") go(1);
    else if (event.key === "ArrowLeft") go(-1);
    else return;
    event.preventDefault();
  }
</script>

<svelte:window {onkeydown} onbeforeunload={() => flush()} />

<div class="absolute inset-0 overflow-auto bg-background [transition:padding-left_var(--motion)]" style:padding-left="{inset}px">
  {#if cards?.length === 0}
    <EmptyState icon="cards" title="Add your first card" action={{ label: "Add Card", run: addCard }} />
  {:else if cards && !editing}
    <div class="mx-auto flex min-h-full max-w-2xl flex-col justify-center gap-6 px-10 py-14">
      {#if studying}
        {#key studying.id}
          <!-- Mousedown is prevented so the card never takes focus, which would make Space press it as well. -->
          <button
            class="flex aspect-[3/2] w-full cursor-pointer flex-col overflow-hidden rounded-3xl border-0 bg-(--note) p-0 text-inherit"
            title="Flip Card"
            onmousedown={(event) => event.preventDefault()}
            onclick={() => (revealed = !revealed)}
          >
            {#key revealed}
              <Markdown
                class="card-markdown study min-h-0 flex-1 overflow-auto"
                value={revealed ? studying.back : studying.front}
                editable={false}
                {onerror}
              />
            {/key}
          </button>
        {/key}
        <div class="flex items-center justify-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            class="[&_svg:not([class*='size-'])]:size-5"
            title="Previous Card"
            aria-label="Previous Card"
            disabled={index === 0}
            onclick={() => go(-1)}
          >
            <Icon name="chevronLeft" />
          </Button>
          <span class="text-muted-foreground w-16 text-center text-sm tabular-nums">{index + 1} / {studyable.length}</span>
          <Button
            variant="ghost"
            size="icon"
            class="[&_svg:not([class*='size-'])]:size-5"
            title="Next Card"
            aria-label="Next Card"
            disabled={index === studyable.length - 1}
            onclick={() => go(1)}
          >
            <Icon name="chevronRight" />
          </Button>
        </div>
      {:else}
        <p class="text-muted-foreground m-0 text-center">No cards to study yet.</p>
      {/if}
    </div>
  {:else if cards}
    <div class="mx-auto flex w-full max-w-2xl flex-col gap-4 px-10 pt-14 pb-24">
      <header class="mb-2 flex items-center gap-3">
        <h1 class="m-0 flex-1 text-2xl font-semibold">{name}</h1>
        <span class="text-muted-foreground text-sm">{cards.length} {cards.length === 1 ? "card" : "cards"}</span>
        <Button onclick={study}>Study</Button>
      </header>
      {#each cards as card (card.id)}
        {@const side = sides[card.id] ?? "front"}
        <div class="group relative flex aspect-[3/2] flex-col rounded-3xl bg-(--note)">
          <ToggleGroup.Root
            type="single"
            variant="outline"
            size="sm"
            class="m-5 mb-0"
            value={side}
            onValueChange={(value) => value && (sides[card.id] = value as "front" | "back")}
          >
            <ToggleGroup.Item value="front">Front</ToggleGroup.Item>
            <ToggleGroup.Item value="back">Back</ToggleGroup.Item>
          </ToggleGroup.Root>
          {#key side}
            <Markdown
              class="card-markdown flex-1"
              value={card[side]}
              placeholder={side === "front" ? "Front" : "Back"}
              autofocus={card.id === added && side === "front"}
              onchange={(text) => edit(card, side, text)}
              {onerror}
            />
          {/key}
          <Button
            variant="ghost"
            size="icon-sm"
            class="text-muted-foreground absolute top-5 right-5 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
            title="Delete Card"
            aria-label="Delete Card"
            onclick={() => removeCard(card.id)}
          >
            <Icon name="trash" size={16} />
          </Button>
        </div>
      {/each}
      <Button variant="ghost" class="text-muted-foreground self-start" onclick={addCard}>
        <Icon name="add" size={16} /> Add Card
      </Button>
    </div>
  {/if}
</div>
