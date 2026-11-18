import type { Card, Review } from "../../electron/library.ts";

export const ratings = ["again", "hard", "good", "easy"] as const;
export type Rating = (typeof ratings)[number];

const DAY = 24 * 60 * 60 * 1000;

export const isDue = (card: Card, now = Date.now()) => !card.review || Date.parse(card.review.due) <= now;

/** A simplified SM-2: each rating sets the days until the card comes back and nudges how fast that gap grows. */
export function schedule(review: Review | undefined, rating: Rating, now = Date.now()): Review {
  const last = review?.interval ?? 0;
  const ease = review?.ease ?? 2.5;
  const next = {
    again: { interval: 0, ease: ease - 0.2 },
    hard: { interval: Math.max(1, Math.round(last * 1.2)), ease: ease - 0.15 },
    good: { interval: last ? Math.max(last + 1, Math.round(last * ease)) : 1, ease },
    easy: { interval: last ? Math.max(last + 2, Math.round(last * ease * 1.3)) : 4, ease: ease + 0.15 },
  }[rating];
  return {
    due: new Date(now + next.interval * DAY).toISOString(),
    interval: next.interval,
    ease: Math.max(1.3, Math.round(next.ease * 100) / 100),
  };
}
