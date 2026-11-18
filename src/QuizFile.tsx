import { useEffect, useState } from "react";
import EmptyState from "./EmptyState.tsx";
import Quiz from "./Quiz.tsx";
import { parseQuiz, type Quiz as QuizData } from "./quiz.ts";

export default function QuizFile({ path, inset = 0, onerror }: { path: string; inset?: number; onerror: (error: unknown) => void }) {
  /** Undefined until the file has loaded, null when it doesn't hold a quiz. */
  const [quiz, setQuiz] = useState<QuizData | null>();

  useEffect(() => {
    (async () => {
      try {
        const parsed = parseQuiz(await window.smrt.readQuiz(path));
        setQuiz(parsed && { title: path.split(/[\\/]/).pop()?.replace(/\.quiz$/i, ""), ...parsed });
      } catch (error) {
        onerror(error);
      }
    })();
    // Remounted with a key whenever the file changes.
  }, []);

  return (
    <div className="absolute inset-0 overflow-auto bg-background [transition:padding-left_var(--motion)]" style={{ paddingLeft: inset }}>
      {quiz ? (
        <div className="mx-auto flex min-h-full max-w-2xl flex-col justify-center px-10 py-14">
          <Quiz quiz={quiz} />
        </div>
      ) : (
        quiz === null && (
          <EmptyState icon="checklist" title="This quiz can't be shown" description="Its questions aren't in a form Smrt understands." />
        )
      )}
    </div>
  );
}
