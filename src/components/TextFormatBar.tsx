import { AnimatePresence, motion } from "motion/react";
import type { PageNote } from "../../electron/library.ts";
import Icon from "./Icon.tsx";
import { grow, slide } from "../lib/transitions.ts";

export const TEXT_SIZES = [8, 10, 12, 14, 18, 24, 32, 48];
export const TEXT_STYLES = [
  ["bold", "Bold"],
  ["italic", "Italic"],
  ["underline", "Underline"],
] as const;
/** Dark enough to read on a white page. */
export const TEXT_COLORS = [
  ["#000000", "Black"],
  ["#d70015", "Red"],
  ["#c93400", "Orange"],
  ["#248a3d", "Green"],
  ["#0040dd", "Blue"],
  ["#8944ab", "Purple"],
] as const;

/** Formats the text box being edited; it replaces the PDF toolbar meanwhile. */
export default function TextFormatBar({
  note,
  picking,
  onToggleStyle,
  onResize,
  onColor,
  onPick,
}: {
  note: PageNote;
  /** Whether every text colour shows instead of just the current one. */
  picking: boolean;
  onToggleStyle: (style: (typeof TEXT_STYLES)[number][0]) => void;
  onResize: (step: 1 | -1) => void;
  onColor: (color: string) => void;
  onPick: () => void;
}) {
  const size = note.size ?? 14;
  return (
    // Preventing mousedown keeps the note focused, so it stays in editing.
    <motion.div
      className="bottom-toolbar text-format floating"
      role="toolbar"
      tabIndex={-1}
      style={{ x: "-50%" }}
      {...grow(0.9)}
      onMouseDown={(event) => event.preventDefault()}
    >
      {TEXT_STYLES.map(([style, label]) => (
        <button
          key={style}
          className={`icon-button ${note[style] ? "active" : ""}`}
          title={label}
          aria-label={label}
          aria-pressed={!!note[style]}
          onClick={() => onToggleStyle(style)}
        >
          <Icon name={style} />
        </button>
      ))}
      <div className="toolbar-separator"></div>
      <button
        className="icon-button"
        title="Smaller Text"
        aria-label="Smaller Text"
        aria-disabled={size <= TEXT_SIZES[0]}
        onClick={() => onResize(-1)}
      >
        <Icon name="minus" />
      </button>
      <span className="text-size">{size}</span>
      <button
        className="icon-button"
        title="Larger Text"
        aria-label="Larger Text"
        aria-disabled={size >= TEXT_SIZES.at(-1)!}
        onClick={() => onResize(1)}
      >
        <Icon name="add" />
      </button>
      <div className="toolbar-separator"></div>
      {/* Only the current colour shows; clicking it slides the others out around it. */}
      <div className="text-colors">
        <AnimatePresence initial={false}>
          {TEXT_COLORS.map(([color, label]) => {
            const current = (note.color ?? TEXT_COLORS[0][0]) === color;
            return (
              (current || picking) && (
                // Padded so the clip leaves room for the active swatch's outline.
                <motion.span key={color} className="-m-1 flex p-1" {...slide}>
                  <button
                    className={`swatch ${current && picking ? "active" : ""}`}
                    style={{ background: color }}
                    title={picking ? label : "Text Colour"}
                    aria-label={picking ? `${label} Text` : "Text Colour"}
                    aria-pressed={picking ? current : undefined}
                    aria-expanded={current ? picking : undefined}
                    onClick={() => (picking ? onColor(color) : onPick())}
                  ></button>
                </motion.span>
              )
            );
          })}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}
