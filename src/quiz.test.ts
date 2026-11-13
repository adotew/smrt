import assert from "node:assert/strict";
import test from "node:test";
import { isCorrect, parseQuiz, quizSegments } from "./quiz.ts";

const quiz = (questions: unknown, title?: unknown) => parseQuiz(JSON.stringify({ title, questions }));

test("every question type parses into something to answer", () => {
  const parsed = quiz(
    [
      { type: "choice", prompt: "One?", choices: ["a", "b", "c"], answer: 1, explanation: "Because." },
      { type: "choice", prompt: "Several?", choices: ["a", "b", "c"], answer: [0, 2, 2] },
      { type: "truefalse", prompt: "Really?", answer: false },
      { type: "blank", prompt: "The capital is ___.", answer: ["New York", "NYC"] },
      { type: "blank", prompt: "One spelling", answer: "Paris" },
    ],
    "Sample",
  );
  assert.deepEqual(parsed, {
    title: "Sample",
    questions: [
      { type: "choice", prompt: "One?", explanation: "Because.", choices: ["a", "b", "c"], correct: [1], multiple: false },
      { type: "choice", prompt: "Several?", choices: ["a", "b", "c"], correct: [0, 2], multiple: true },
      { type: "choice", prompt: "Really?", choices: ["True", "False"], correct: [1], multiple: false },
      { type: "blank", prompt: "The capital is ___.", accepted: ["New York", "NYC"] },
      { type: "blank", prompt: "One spelling", accepted: ["Paris"] },
    ],
  });
  const [one, several, , blank] = parsed!.questions;
  assert.ok(isCorrect(one, [1]));
  assert.ok(!isCorrect(one, [0]));
  assert.ok(isCorrect(several, [2, 0]));
  assert.ok(!isCorrect(several, [0]));
  assert.ok(!isCorrect(several, [0, 1, 2]));
  assert.ok(isCorrect(blank, "  new   york "));
  assert.ok(!isCorrect(blank, "Boston"));
  assert.ok(!isCorrect(blank, ""));
});

test("anything malformed is refused whole", () => {
  const good = { type: "truefalse", prompt: "Really?", answer: true };
  assert.equal(parseQuiz("{not json"), null);
  assert.equal(parseQuiz("null"), null);
  assert.equal(parseQuiz('{"questions": []}'), null);
  for (const bad of [
    null,
    { ...good, prompt: " " },
    { ...good, answer: "true" },
    { ...good, type: "essay" },
    { type: "choice", prompt: "?", choices: ["a"], answer: 0 },
    { type: "choice", prompt: "?", choices: ["a", "b"], answer: 2 },
    { type: "choice", prompt: "?", choices: ["a", "b"], answer: [] },
    { type: "choice", prompt: "?", choices: ["a", 1], answer: 0 },
    { type: "choice", prompt: "?", choices: ["a", "b"], answer: "a" },
    { type: "blank", prompt: "?", answer: [] },
    { type: "blank", prompt: "?", answer: [""] },
  ]) {
    assert.equal(quiz([good, bad]), null, JSON.stringify(bad));
  }
});

test("a reply splits into markdown and quiz blocks, finished or still streaming", () => {
  assert.deepEqual(quizSegments("Just text\n```js\ncode\n```"), [{ type: "text", text: "Just text\n```js\ncode\n```" }]);
  assert.deepEqual(quizSegments('Try this:\n\n```quiz\n{"a": 1}\n```\n\nGood luck.\n```quiz \n{}\n```\n'), [
    { type: "text", text: "Try this:\n\n" },
    { type: "quiz", text: '{"a": 1}\n', complete: true },
    { type: "text", text: "\n\nGood luck.\n" },
    { type: "quiz", text: "{}\n", complete: true },
  ]);
  assert.deepEqual(quizSegments("```quiz"), [{ type: "quiz", text: "", complete: false }]);
  assert.deepEqual(quizSegments('```quiz\n{"questions": ['), [{ type: "quiz", text: '{"questions": [', complete: false }]);
  assert.deepEqual(quizSegments("```quizzes\nx\n```"), [{ type: "text", text: "```quizzes\nx\n```" }]);
});
