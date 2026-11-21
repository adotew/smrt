import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import type { Card } from "../../electron/library.ts";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import EmptyState from "../components/EmptyState.tsx";
import FlipCard from "../components/FlipCard.tsx";
import Icon from "../components/Icon.tsx";
import Markdown from "../components/Markdown.tsx";
import { isDue, ratings, schedule, type Rating } from "../lib/review.ts";

const api = window.smrt;

export interface DeckHandle {
  /** Saves pending edits and resolves once every save has finished. */
  flush: () => Promise<void>;
  startEditing: () => void;
}

const ratingStyles = {
  again: { icon: "close", color: "text-red-500", label: "Again" },
  hard: { icon: "minus", color: "text-amber-500", label: "Hard" },
  good: { icon: "check", color: "text-green-500", label: "Good" },
  easy: { icon: "bolt", color: "text-blue-500", label: "Easy" },
} as const;

export default function Deck({
  ref,
  path,
  revision = 0,
  active = true,
  onerror,
}: {
  ref?: Ref<DeckHandle>;
  path: string;
  /** Bumped when the assistant writes the deck, so it reloads without flushing stale edits over it. */
  revision?: number;
  /** Only the active pane's deck answers the keyboard. */
  active?: boolean;
  onerror: (error: unknown) => void;
}) {
  /** Null until the deck has loaded, so a deck that failed to load is never overwritten. */
  const [cards, setCardsState] = useState<Card[] | null>(null);
  const [loaded, setLoaded] = useState(0);
  // Saves and editor callbacks read the latest cards, which may not have rendered yet.
  const cardsRef = useRef(cards);
  const setCards = (next: Card[]) => {
    cardsRef.current = next;
    setCardsState(next);
  };
  /** Ids of the cards left in this study session, the shown one first. */
  const [queue, setQueue] = useState<string[]>([]);
  /** How many cards this study session started with, for the progress bar. */
  const [total, setTotal] = useState(0);
  const [revealed, setRevealed] = useState(false);
  /** Decks open in study mode. */
  const [editing, setEditing] = useState(false);
  const editingRef = useRef(editing);
  editingRef.current = editing;
  /** The card just added, whose front takes focus. */
  const [added, setAdded] = useState<string | null>(null);
  /** The side each card shows while editing; missing means the front. */
  const [sides, setSides] = useState<Record<string, "front" | "back">>({});
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  /** Saves run one after another so an older one never lands last. */
  const saving = useRef<Promise<void>>(Promise.resolve());
  const mounted = useRef(false);

  const name = path.split(/[\\/]/).pop()?.replace(/\.cards$/i, "");
  const studyableOf = (cards: Card[] | null) => cards?.filter((card) => card.front.trim() || card.back.trim()) ?? [];
  const studyable = studyableOf(cards);
  const studying = cards?.find((card) => card.id === queue[0]);
  const nextDue = Math.min(...studyable.map((card) => (card.review ? Date.parse(card.review.due) : Infinity)));
  const daysToNext = Math.max(1, Math.ceil((nextDue - Date.now()) / (24 * 60 * 60 * 1000)));

  function save() {
    clearTimeout(timer.current);
    timer.current = undefined;
    const cards = cardsRef.current;
    if (!cards) return;
    saving.current = saving.current.then(() => api.saveDeck(path, { cards })).catch(onerror);
  }

  function flush() {
    if (timer.current) save();
    return saving.current;
  }

  useImperativeHandle(ref, () => ({ flush, startEditing: () => setEditing(true) }));

  useEffect(() => {
    const onbeforeunload = () => void flush();
    window.addEventListener("beforeunload", onbeforeunload);
    return () => {
      window.removeEventListener("beforeunload", onbeforeunload);
      flush();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const reload = mounted.current;
    mounted.current = true;
    if (reload) {
      clearTimeout(timer.current);
      timer.current = undefined;
    }
    (async () => {
      if (reload) await saving.current;
      try {
        const next = (await api.readDeck(path)).cards;
        if (cancelled) return;
        setCards(next);
        setLoaded((n) => n + 1);
        // The sidebar's Edit Cards may have asked for editing before the deck loaded.
        if (!editingRef.current) study(false, next);
      } catch (error) {
        if (!cancelled) onerror(error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [revision]);

  function edit(id: string, side: "front" | "back", text: string) {
    setCards(cardsRef.current!.map((card) => (card.id === id ? { ...card, [side]: text } : card)));
    clearTimeout(timer.current);
    timer.current = setTimeout(save, 400);
  }

  function addCard() {
    if (!cards) return;
    const id = crypto.randomUUID();
    setCards([...cards, { id, front: "", back: "" }]);
    setAdded(id);
    setEditing(true);
    save();
  }

  function removeCard(id: string) {
    if (!cards) return;
    setCards(cards.filter((card) => card.id !== id));
    save();
  }

  /** Studies the cards that are due, or every card when asked. */
  function study(all = false, from = cards) {
    const next = studyableOf(from)
      .filter((card) => all || isDue(card))
      .map((card) => card.id);
    setEditing(false);
    setRevealed(false);
    setQueue(next);
    setTotal(next.length);
  }

  function rate(rating: Rating) {
    if (!studying || !cards) return;
    const review = schedule(studying.review, rating);
    setCards(cards.map((card) => (card.id === studying.id ? { ...card, review } : card)));
    // Cards answered Again come back at the end of this session.
    setQueue(rating === "again" ? [...queue.slice(1), queue[0]] : queue.slice(1));
    setRevealed(false);
    save();
  }

  useEffect(() => {
    function onkeydown(event: KeyboardEvent) {
      // The focused card flips itself on Space and prevents the default.
      if (event.defaultPrevented || !active || editing || !studying || event.metaKey || event.ctrlKey || event.altKey) return;
      if ((event.target as Element).closest("input, textarea, dialog, button, a, [contenteditable]")) return;
      if (event.key === " ") setRevealed((revealed) => !revealed);
      else if (/^[1-4]$/.test(event.key)) rate(ratings[Number(event.key) - 1]);
      else return;
      event.preventDefault();
    }
    window.addEventListener("keydown", onkeydown);
    return () => window.removeEventListener("keydown", onkeydown);
  });

  return (
    <div className="absolute inset-0 overflow-auto bg-background">
      {cards?.length === 0 ? (
        <EmptyState icon="cards" title="Add your first card" action={{ label: "Add Card", run: addCard }} />
      ) : cards && !editing ? (
        <div className="mx-auto flex min-h-full max-w-2xl flex-col justify-center gap-6 px-10 py-14">
          {studying ? (
            <>
              <div
                className="bg-muted h-1.5 overflow-hidden rounded-full"
                role="progressbar"
                aria-label="Cards Done"
                aria-valuemin={0}
                aria-valuemax={total}
                aria-valuenow={total - queue.length}
              >
                <div
                  className="bg-primary h-full rounded-full [transition:width_var(--motion)]"
                  style={{ width: `${((total - queue.length) / total) * 100}%` }}
                ></div>
              </div>
              <FlipCard
                key={`${studying.id}-${loaded}`}
                className="aspect-[3/2] w-full"
                flipped={revealed}
                onFlippedChange={setRevealed}
                front={
                  <Markdown className="card-markdown study min-h-0 flex-1 overflow-auto" value={studying.front} editable={false} onerror={onerror} />
                }
                back={
                  <Markdown className="card-markdown study min-h-0 flex-1 overflow-auto" value={studying.back} editable={false} onerror={onerror} />
                }
              />
              <div className="mt-6 flex items-center justify-center gap-4">
                {ratings.map((rating, i) => {
                  const { icon, color, label } = ratingStyles[rating];
                  return (
                    <Button
                      key={rating}
                      variant="secondary"
                      className={`size-16 rounded-full [&_svg:not([class*='size-'])]:size-7 ${color}`}
                      title={`${label} (${i + 1})`}
                      aria-label={label}
                      onClick={() => rate(rating)}
                    >
                      <Icon name={icon} />
                    </Button>
                  );
                })}
              </div>
            </>
          ) : studyable.length ? (
            <div className="flex flex-col items-center gap-3 text-center">
              <p className="m-0 text-lg font-medium">All caught up</p>
              {nextDue < Infinity && (
                <p className="text-muted-foreground m-0 text-sm">Next review {daysToNext === 1 ? "tomorrow" : `in ${daysToNext} days`}.</p>
              )}
              <Button variant="outline" onClick={() => study(true)}>
                Study All Cards
              </Button>
            </div>
          ) : (
            <p className="text-muted-foreground m-0 text-center">No cards to study yet.</p>
          )}
        </div>
      ) : (
        cards && (
          <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-10 pt-14 pb-24">
            <header className="mb-2 flex items-center gap-3">
              <h1 className="m-0 flex-1 text-2xl font-semibold">{name}</h1>
              <span className="text-muted-foreground text-sm">
                {cards.length} {cards.length === 1 ? "card" : "cards"}
              </span>
              <Button onClick={() => study()}>Study</Button>
            </header>
            {cards.map((card) => {
              const side = sides[card.id] ?? "front";
              return (
                <div key={card.id} className="group relative flex aspect-[3/2] flex-col rounded-3xl bg-(--note)">
                  <ToggleGroup
                    type="single"
                    variant="outline"
                    size="sm"
                    spacing={0}
                    className="m-5 mb-0"
                    value={side}
                    onValueChange={(value) => value && setSides({ ...sides, [card.id]: value as "front" | "back" })}
                  >
                    <ToggleGroupItem value="front">Front</ToggleGroupItem>
                    <ToggleGroupItem value="back">Back</ToggleGroupItem>
                  </ToggleGroup>
                  <Markdown
                    key={`${side}-${loaded}`}
                    className="card-markdown flex-1"
                    value={card[side]}
                    placeholder={side === "front" ? "Front" : "Back"}
                    autofocus={card.id === added && side === "front"}
                    onchange={(text) => edit(card.id, side, text)}
                    onerror={onerror}
                  />
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-muted-foreground absolute top-5 right-5 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                    title="Delete Card"
                    aria-label="Delete Card"
                    onClick={() => removeCard(card.id)}
                  >
                    <Icon name="trash" size={16} />
                  </Button>
                </div>
              );
            })}
            <Button variant="ghost" className="text-muted-foreground self-start" onClick={addCard}>
              <Icon name="add" size={16} /> Add Card
            </Button>
          </div>
        )
      )}
    </div>
  );
}
