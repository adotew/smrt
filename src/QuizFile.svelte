<script lang="ts">
  import { onMount } from "svelte";
  import EmptyState from "./EmptyState.svelte";
  import Quiz from "./Quiz.svelte";
  import { parseQuiz, type Quiz as QuizData } from "./quiz.ts";

  let { path, inset = 0, onerror }: { path: string; inset?: number; onerror: (error: unknown) => void } = $props();

  /** Undefined until the file has loaded, null when it doesn't hold a quiz. */
  let quiz = $state.raw<QuizData | null>();

  onMount(async () => {
    try {
      const parsed = parseQuiz(await window.smrt.readQuiz(path));
      quiz = parsed && { title: path.split(/[\\/]/).pop()?.replace(/\.quiz$/i, ""), ...parsed };
    } catch (error) {
      onerror(error);
    }
  });
</script>

<div class="absolute inset-0 overflow-auto bg-background [transition:padding-left_var(--motion)]" style:padding-left="{inset}px">
  {#if quiz}
    <div class="mx-auto flex min-h-full max-w-2xl flex-col justify-center px-10 py-14">
      <Quiz {quiz} />
    </div>
  {:else if quiz === null}
    <EmptyState icon="checklist" title="This quiz can't be shown" description="Its questions aren't in a form Smrt understands." />
  {/if}
</div>
