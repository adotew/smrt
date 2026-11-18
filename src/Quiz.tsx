import { Fragment, useState } from "react";
import { Streamdown } from "streamdown";
import { Button } from "$lib/components/ui/button";
import Icon, { streamdownIcons } from "./Icon.tsx";
import { isCorrect, type Quiz as QuizData } from "./quiz.ts";

export default function Quiz({ quiz, compact = false }: { quiz: QuizData; compact?: boolean }) {
  /** The question being answered; past the last one, the score shows. */
  const [index, setIndex] = useState(0);
  const [selected, setSelected] = useState<number[]>([]);
  const [typed, setTyped] = useState("");
  /** Whether the answer has been marked, which locks it. */
  const [checked, setChecked] = useState(false);
  const [score, setScore] = useState(0);

  const question = quiz.questions.at(index);
  const answer = question?.type === "blank" ? typed : selected;
  const answered = index + (checked ? 1 : 0);
  const needsCheck = question?.type === "blank" || question?.multiple;
  const correct = !!question && isCorrect(question, answer);

  function check(answer: string | number[]) {
    if (checked || !question || !answer.length) return;
    setChecked(true);
    if (isCorrect(question, answer)) setScore((score) => score + 1);
  }

  function pick(choice: number) {
    if (checked || question?.type !== "choice") return;
    if (question.multiple) {
      setSelected(selected.includes(choice) ? selected.filter((i) => i !== choice) : [...selected, choice]);
    } else {
      setSelected([choice]);
      check([choice]);
    }
  }

  function go(to: number) {
    setIndex(to);
    setSelected([]);
    setTyped("");
    setChecked(false);
    if (to === 0) setScore(0);
  }

  return (
    <div className={`relative flex flex-col gap-3 overflow-hidden rounded-xl border border-border p-4 ${compact ? "text-sm" : "text-[15px]"}`}>
      <div
        className="absolute inset-x-0 top-0 h-1 bg-muted"
        role="progressbar"
        aria-label="Progress"
        aria-valuemin={0}
        aria-valuemax={quiz.questions.length}
        aria-valuenow={answered}
      >
        <div className="h-full bg-primary transition-[width] duration-300" style={{ width: `${(answered / quiz.questions.length) * 100}%` }}></div>
      </div>
      <div className="flex justify-between gap-3 text-xs text-muted-foreground">
        <span className="truncate">{quiz.title ?? "Quiz"}</span>
        {question && (
          <span className="tabular-nums">
            {index + 1} / {quiz.questions.length}
          </span>
        )}
      </div>
      {question ? (
        <Fragment key={index}>
          <Streamdown mode="static" icons={streamdownIcons} className="flex flex-col gap-2 leading-relaxed font-medium *:m-0">
            {question.prompt}
          </Streamdown>
          {question.type === "choice" ? (
            <>
              {question.multiple && <p className="m-0 text-xs text-muted-foreground">Select all that apply.</p>}
              <div className="flex flex-col gap-2">
                {question.choices.map((choice, i) => {
                  const picked = selected.includes(i);
                  const right = checked && question.correct.includes(i);
                  const wrong = checked && picked && !right;
                  return (
                    // Not disabled once checked, so the keyboard focus stays where it is.
                    <button
                      key={i}
                      type="button"
                      className={`flex items-center justify-between gap-3 rounded-lg border bg-transparent px-3 py-2 text-left text-inherit
                        ${right ? "border-emerald-600 dark:border-emerald-400" : wrong ? "border-destructive" : picked ? "border-primary" : "border-border"}
                        ${checked ? "cursor-default" : "cursor-pointer hover:bg-muted"}`}
                      aria-pressed={picked}
                      aria-disabled={checked}
                      onClick={() => pick(i)}
                    >
                      <Streamdown mode="static" icons={streamdownIcons} className="*:m-0 [&_p]:m-0">
                        {choice}
                      </Streamdown>
                      {right ? (
                        <span className="flex text-emerald-600 dark:text-emerald-400">
                          <Icon name="check" size={16} />
                        </span>
                      ) : (
                        wrong && (
                          <span className="flex text-destructive">
                            <Icon name="close" size={16} />
                          </span>
                        )
                      )}
                    </button>
                  );
                })}
              </div>
            </>
          ) : (
            // Only later questions take focus, so a quiz arriving in the chat doesn't steal it.
            <input
              className="rounded-lg border border-border bg-transparent px-3 py-2 text-inherit outline-none focus-visible:border-primary"
              placeholder="Your answer"
              aria-label="Your answer"
              readOnly={checked}
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && check(typed)}
              autoFocus={index > 0}
            />
          )}
          {checked && (
            <div className="flex flex-col gap-1" role="status">
              <p className={`m-0 font-medium ${correct ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"}`}>
                {correct ? "Correct" : question.type === "blank" ? `Not quite. The answer is ${question.accepted[0]}.` : "Not quite"}
              </p>
              {question.explanation && (
                <Streamdown mode="static" icons={streamdownIcons} className="flex flex-col gap-2 leading-relaxed text-muted-foreground *:m-0">
                  {question.explanation}
                </Streamdown>
              )}
            </div>
          )}
          <div className="flex justify-end">
            {checked ? (
              <Button key="next" size="sm" onClick={() => go(index + 1)} autoFocus>
                {index === quiz.questions.length - 1 ? "Finish" : "Next"}
              </Button>
            ) : (
              needsCheck && (
                <Button key="check" size="sm" disabled={!answer.length} onClick={() => check(answer)}>
                  Check
                </Button>
              )
            )}
          </div>
        </Fragment>
      ) : (
        <>
          <p className="m-0 font-medium" role="status">
            You got {score} of {quiz.questions.length} right.
          </p>
          <div className="flex justify-end">
            <Button size="sm" variant="outline" onClick={() => go(0)}>
              Try Again
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
