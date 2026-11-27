import type { Ref } from "react";
import { motion } from "motion/react";
import { IconButton } from "./Icon.tsx";
import { grow } from "../lib/transitions.ts";

export default function FindBar({
  ref,
  query,
  count,
  current,
  onQueryChange,
  onStep,
  onClose,
}: {
  ref?: Ref<HTMLInputElement>;
  query: string;
  count: number;
  /** The shown match's index. */
  current: number;
  onQueryChange: (query: string) => void;
  onStep: (step: 1 | -1) => void;
  onClose: () => void;
}) {
  return (
    <motion.div className="find-bar floating" role="search" {...grow(0.9)}>
      <input
        ref={ref}
        value={query}
        placeholder="Find"
        aria-label="Find in document"
        spellCheck={false}
        onChange={(event) => onQueryChange(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") onStep(event.shiftKey ? -1 : 1);
          else if (event.key === "Escape") onClose();
          else return;
          event.preventDefault();
        }}
      />
      <span className="find-count" aria-live="polite">
        {query.trim() && (count ? `${current + 1} of ${count}` : "No results")}
      </span>
      <IconButton name="arrowUp" size={16} title="Previous Match" disabled={!count} onClick={() => onStep(-1)} />
      <IconButton name="arrowDown" size={16} title="Next Match" disabled={!count} onClick={() => onStep(1)} />
      <IconButton name="close" size={16} title="Close" onClick={onClose} />
    </motion.div>
  );
}
