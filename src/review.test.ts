import assert from "node:assert/strict";
import test from "node:test";
import { isDue, schedule } from "./review.ts";

const now = Date.parse("2026-01-01T00:00:00Z");
const days = (due: string) => (Date.parse(due) - now) / (24 * 60 * 60 * 1000);

test("new cards come back sooner the harder they were", () => {
  assert.deepEqual(
    (["again", "hard", "good", "easy"] as const).map((rating) => days(schedule(undefined, rating, now).due)),
    [0, 1, 1, 4],
  );
});

test("gaps grow with each good answer and reset on again", () => {
  let review = schedule(undefined, "good", now);
  review = schedule(review, "good", now);
  assert.equal(review.interval, 3);
  review = schedule(review, "good", now);
  assert.equal(review.interval, 8);
  review = schedule(review, "again", now);
  assert.deepEqual([review.interval, review.ease], [0, 2.3]);
});

test("ease never drops below 1.3", () => {
  let review = schedule(undefined, "again", now);
  for (let i = 0; i < 20; i++) review = schedule(review, "hard", now);
  assert.equal(review.ease, 1.3);
});

test("cards without a review are due", () => {
  const card = { id: "a", front: "", back: "" };
  assert.ok(isDue(card, now));
  assert.ok(!isDue({ ...card, review: schedule(undefined, "good", now) }, now));
  assert.ok(isDue({ ...card, review: schedule(undefined, "again", now) }, now));
});
