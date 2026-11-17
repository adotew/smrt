<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import type { Card } from "../electron/library.ts";
  import { Button } from "$lib/components/ui/button";
  import * as ToggleGroup from "$lib/components/ui/toggle-group";
  import EmptyState from "./EmptyState.svelte";
  import FlipCard from "./FlipCard.svelte";
  import Icon from "./Icon.svelte";
  import Markdown from "./Markdown.svelte";
  import { isDue, ratings, schedule, type Rating } from "./review.ts";

  const api = window.smrt;

  let {
    path,
    active = true,
    inset = 0,
    onerror,
  }: {
    path: string;
    /** Only the active pane's deck answers the keyboard. */
    active?: boolean;
    /** Width on the left covered by the floating sidebar. */
    inset?: number;
    onerror: (error: unknown) => void;
  } = $props();

  /** Null until the deck has loaded, so a deck that failed to load is never overwritten. */
  let cards = $state<Card[] | null>(null);
  /** Ids of the cards left in this study session, the shown one first. */
  let queue = $state<string[]>([]);
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
  const studying = $derived(cards?.find((card) => card.id === queue[0]));
  const nextDue = $derived(
    Math.min(...studyable.map((card) => (card.review ? Date.parse(card.review.due) : Infinity))),
  );
  const daysToNext = $derived(Math.max(1, Math.ceil((nextDue - Date.now()) / (24 * 60 * 60 * 1000))));

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

  /** Studies the cards that are due, or every card when asked. */
  function study(all = false) {
    editing = false;
    revealed = false;
    queue = studyable.filter((card) => all || isDue(card)).map((card) => card.id);
  }

  const ratingStyles = {
    again: { icon: "close", color: "text-red-500", label: "Again" },
    hard: { icon: "minus", color: "text-amber-500", label: "Hard" },
    good: { icon: "check", color: "text-green-500", label: "Good" },
    easy: { icon: "bolt", color: "text-blue-500", label: "Easy" },
  } as const;

  function rate(rating: Rating) {
    if (!studying) return;
    studying.review = schedule(studying.review, rating);
    // Cards answered Again come back at the end of this session.
    queue = rating === "again" ? [...queue.slice(1), queue[0]] : queue.slice(1);
    revealed = false;
    save();
  }

  function onkeydown(event: KeyboardEvent) {
    // The focused card flips itself on Space and prevents the default.
    if (event.defaultPrevented || !active || editing || !studying || event.metaKey || event.ctrlKey || event.altKey) return;
    if ((event.target as Element).closest("input, textarea, dialog")) return;
    if (event.key === " ") revealed = !revealed;
    else if (/^[1-4]$/.test(event.key)) rate(ratings[Number(event.key) - 1]);
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
          <FlipCard class="aspect-[3/2] w-full" bind:flipped={revealed}>
            {#snippet front()}
              <Markdown class="card-markdown study min-h-0 flex-1 overflow-auto" value={studying.front} editable={false} {onerror} />
            {/snippet}
            {#snippet back()}
              <Markdown class="card-markdown study min-h-0 flex-1 overflow-auto" value={studying.back} editable={false} {onerror} />
            {/snippet}
          </FlipCard>
        {/key}
        <div class="mt-6 flex items-center justify-center gap-4">
          {#each ratings as rating, i (rating)}
            {@const { icon, color, label } = ratingStyles[rating]}
            <Button
              variant="secondary"
              class="size-16 rounded-full [&_svg:not([class*='size-'])]:size-7 {color}"
              title="{label} ({i + 1})"
              aria-label={label}
              onclick={() => rate(rating)}
            >
              <Icon name={icon} />
            </Button>
          {/each}
          </div>
        <span class="text-muted-foreground -mt-2 text-center text-sm tabular-nums">{queue.length} left</span>
      {:else if studyable.length}
        <div class="flex flex-col items-center gap-3 text-center">
          <p class="m-0 text-lg font-medium">All caught up</p>
          {#if nextDue < Infinity}
            <p class="text-muted-foreground m-0 text-sm">Next review {daysToNext === 1 ? "tomorrow" : `in ${daysToNext} days`}.</p>
          {/if}
          <Button variant="outline" onclick={() => study(true)}>Study All Cards</Button>
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
        <Button onclick={() => study()}>Study</Button>
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
