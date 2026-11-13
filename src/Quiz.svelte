<script lang="ts">
  import { Streamdown } from "svelte-streamdown";
  import { Button } from "$lib/components/ui/button";
  import Icon, { streamdownIcons } from "./Icon.svelte";
  import { isCorrect, type Quiz } from "./quiz.ts";

  let { quiz, compact = false }: { quiz: Quiz; compact?: boolean } = $props();

  /** The question being answered; past the last one, the score shows. */
  let index = $state(0);
  let selected: number[] = $state([]);
  let typed = $state("");
  /** Whether the answer has been marked, which locks it. */
  let checked = $state(false);
  let score = $state(0);

  const question = $derived(quiz.questions.at(index));
  const answer = $derived(question?.type === "blank" ? typed : selected);
  const correct = $derived(!!question && isCorrect(question, answer));
  const answered = $derived(index + (checked ? 1 : 0));
  const needsCheck = $derived(question?.type === "blank" || question?.multiple);

  function check() {
    if (checked || !answer.length) return;
    checked = true;
    if (correct) score++;
  }

  function pick(choice: number) {
    if (checked || question?.type !== "choice") return;
    if (question.multiple) {
      selected = selected.includes(choice) ? selected.filter((i) => i !== choice) : [...selected, choice];
    } else {
      selected = [choice];
      check();
    }
  }

  function go(to: number) {
    index = to;
    selected = [];
    typed = "";
    checked = false;
    if (to === 0) score = 0;
  }
</script>

<div class="relative flex flex-col gap-3 overflow-hidden rounded-xl border border-border p-4 {compact ? 'text-sm' : 'text-[15px]'}">
  <div
    class="absolute inset-x-0 top-0 h-1 bg-muted"
    role="progressbar"
    aria-label="Progress"
    aria-valuemin={0}
    aria-valuemax={quiz.questions.length}
    aria-valuenow={answered}
  >
    <div class="h-full bg-primary transition-[width] duration-300" style:width="{(answered / quiz.questions.length) * 100}%"></div>
  </div>
  <div class="flex justify-between gap-3 text-xs text-muted-foreground">
    <span class="truncate">{quiz.title ?? "Quiz"}</span>
    {#if question}<span class="tabular-nums">{index + 1} / {quiz.questions.length}</span>{/if}
  </div>
  {#if question}
    {#key index}
      <Streamdown content={question.prompt} baseTheme="shadcn" icons={streamdownIcons} static class="flex flex-col gap-2 leading-relaxed font-medium *:m-0" />
      {#if question.type === "choice"}
        {#if question.multiple}<p class="m-0 text-xs text-muted-foreground">Select all that apply.</p>{/if}
        <div class="flex flex-col gap-2">
          {#each question.choices as choice, i (i)}
            {@const picked = selected.includes(i)}
            {@const right = checked && question.correct.includes(i)}
            {@const wrong = checked && picked && !right}
            <!-- Not disabled once checked, so the keyboard focus stays where it is. -->
            <button
              type="button"
              class="flex items-center justify-between gap-3 rounded-lg border bg-transparent px-3 py-2 text-left text-inherit
                {right ? 'border-emerald-600 dark:border-emerald-400' : wrong ? 'border-destructive' : picked ? 'border-primary' : 'border-border'}
                {checked ? 'cursor-default' : 'cursor-pointer hover:bg-muted'}"
              aria-pressed={picked}
              aria-disabled={checked}
              onclick={() => pick(i)}
            >
              <Streamdown content={choice} baseTheme="shadcn" icons={streamdownIcons} static inline />
              {#if right}
                <span class="flex text-emerald-600 dark:text-emerald-400"><Icon name="check" size={16} /></span>
              {:else if wrong}
                <span class="flex text-destructive"><Icon name="close" size={16} /></span>
              {/if}
            </button>
          {/each}
        </div>
      {:else}
        <!-- Only later questions take focus, so a quiz arriving in the chat doesn't steal it. -->
        <input
          class="rounded-lg border border-border bg-transparent px-3 py-2 text-inherit outline-none focus-visible:border-primary"
          placeholder="Your answer"
          aria-label="Your answer"
          readonly={checked}
          bind:value={typed}
          onkeydown={(event) => event.key === "Enter" && check()}
          {@attach (input) => {
            if (index > 0) input.focus();
          }}
        />
      {/if}
      {#if checked}
        <div class="flex flex-col gap-1" role="status">
          <p class="m-0 font-medium {correct ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive'}">
            {correct ? "Correct" : question.type === "blank" ? `Not quite. The answer is ${question.accepted[0]}.` : "Not quite"}
          </p>
          {#if question.explanation}
            <Streamdown
              content={question.explanation}
              baseTheme="shadcn"
              icons={streamdownIcons}
              static
              class="flex flex-col gap-2 leading-relaxed text-muted-foreground *:m-0"
            />
          {/if}
        </div>
      {/if}
      <div class="flex justify-end">
        {#if checked}
          <Button size="sm" onclick={() => go(index + 1)} {@attach (button: HTMLElement) => button.focus()}>
            {index === quiz.questions.length - 1 ? "Finish" : "Next"}
          </Button>
        {:else if needsCheck}
          <Button size="sm" disabled={!answer.length} onclick={check}>Check</Button>
        {/if}
      </div>
    {/key}
  {:else}
    <p class="m-0 font-medium" role="status">You got {score} of {quiz.questions.length} right.</p>
    <div class="flex justify-end">
      <Button size="sm" variant="outline" onclick={() => go(0)}>Try Again</Button>
    </div>
  {/if}
</div>
