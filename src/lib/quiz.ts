/** A quiz as Smrt shows it; `parseQuiz` builds it from what the assistant writes in a ```quiz block or a .quiz file. */
export interface Quiz {
  title?: string;
  questions: Question[];
}
export type Question = { prompt: string; explanation?: string } & (
  | { type: "choice"; choices: string[]; correct: number[]; /** Several choices are right, so the person ticks them. */ multiple: boolean }
  | { type: "blank"; accepted: string[] }
);
/** The chosen indexes of a choice question, or the text typed into a blank. */
export type Answer = number[] | string;

const isText = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

function parseQuestion(raw: unknown): Question | null {
  if (!raw || typeof raw !== "object") return null;
  const { type, prompt, choices, answer, explanation } = raw as Record<string, unknown>;
  if (!isText(prompt)) return null;
  const base = { prompt, ...(isText(explanation) ? { explanation } : {}) };
  const answers: unknown[] = Array.isArray(answer) ? answer : [answer];
  if (type === "truefalse") {
    if (typeof answer !== "boolean") return null;
    return { ...base, type: "choice", choices: ["True", "False"], correct: [answer ? 0 : 1], multiple: false };
  }
  if (type === "choice") {
    if (!Array.isArray(choices) || choices.length < 2 || !choices.every(isText)) return null;
    const inRange = (i: unknown): i is number => Number.isInteger(i) && (i as number) >= 0 && (i as number) < choices.length;
    if (!answers.length || !answers.every(inRange)) return null;
    return { ...base, type: "choice", choices, correct: [...new Set(answers)], multiple: Array.isArray(answer) };
  }
  if (type === "blank") return answers.length && answers.every(isText) ? { ...base, type: "blank", accepted: answers } : null;
  return null;
}

/** Null unless every question is valid: the text comes from a model or a file, and a half-shown quiz would mislead. */
export function parseQuiz(text: string): Quiz | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const { title, questions } = raw as Record<string, unknown>;
  if (!Array.isArray(questions) || !questions.length) return null;
  const parsed = questions.map(parseQuestion);
  if (!parsed.every((q) => q !== null)) return null;
  return { ...(isText(title) ? { title } : {}), questions: parsed };
}

const normalized = (text: string) => text.trim().toLowerCase().replace(/\s+/g, " ");

export function isCorrect(question: Question, answer: Answer) {
  if (question.type === "blank") return typeof answer === "string" && question.accepted.some((a) => normalized(a) === normalized(answer));
  return Array.isArray(answer) && answer.length === question.correct.length && question.correct.every((i) => answer.includes(i));
}

export type Segment = { type: "text"; text: string } | { type: "quiz"; text: string; /** False while its closing fence is still to come. */ complete: boolean };

/** Splits a reply into its markdown and its ```quiz blocks, in order. */
export function quizSegments(markdown: string): Segment[] {
  const segments: Segment[] = [];
  const text = (from: number, to?: number) => {
    const part = markdown.slice(from, to);
    if (part.trim()) segments.push({ type: "text", text: part });
  };
  let end = 0;
  for (const match of markdown.matchAll(/^```quiz[ \t]*(?:\r?\n|(?![^]))([^]*?)(^```[ \t]*\r?$|(?![^]))/gm)) {
    text(end, match.index);
    segments.push({ type: "quiz", text: match[1], complete: !!match[2] });
    end = match.index + match[0].length;
  }
  text(end);
  return segments;
}
