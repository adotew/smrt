/** Cubic ease-out. */
export const ease = [0.33, 1, 0.68, 1] as const;

/** Fades in while growing from `start`, and back out. */
export const grow = (start: number) => ({
  initial: { opacity: 0, scale: start },
  animate: { opacity: 1, scale: 1 },
  exit: { opacity: 0, scale: start },
  transition: { duration: 0.18, ease },
});

/** Opens to the content's width, and closes back to nothing. */
export const slide = {
  initial: { width: 0 },
  animate: { width: "auto" },
  exit: { width: 0 },
  transition: { duration: 0.18, ease },
  style: { overflow: "hidden" },
};
