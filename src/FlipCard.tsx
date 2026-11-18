// React Bits' Flip Card (reactbits.dev/micro/flip-card): flips in 3D on a click, drag or flick.
import { useEffect, useReducer, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { useReducedMotion } from "motion/react";

/** A damped spring like Motion's: stiffness, damping and mass in physical units, with optional starting velocity. */
class Spring {
  current: number;
  #to: number;
  #velocity = 0;
  #frame = 0;
  #last = 0;
  #stiffness: number;
  #damping: number;
  #mass: number;
  #restDelta: number;
  #onChange: () => void;

  constructor(value: number, onChange: () => void, stiffness: number, damping: number, mass = 1, restDelta = 0.001) {
    this.current = this.#to = value;
    this.#onChange = onChange;
    this.#stiffness = stiffness;
    this.#damping = damping;
    this.#mass = mass;
    this.#restDelta = restDelta;
  }

  set(to: number, velocity = this.#velocity) {
    this.#to = to;
    this.#velocity = velocity;
    if (this.#frame) return;
    this.#last = performance.now();
    this.#frame = requestAnimationFrame(this.#tick);
  }

  jump(value: number) {
    this.stop();
    this.current = this.#to = value;
    this.#velocity = 0;
    this.#onChange();
  }

  stop() {
    cancelAnimationFrame(this.#frame);
    this.#frame = 0;
  }

  #tick = (now: number) => {
    const dt = Math.min((now - this.#last) / 1000, 0.064);
    this.#last = now;
    const steps = Math.ceil(dt / 0.002);
    let x = this.current;
    let v = this.#velocity;
    for (let i = 0; i < steps; i++) {
      v += ((-this.#stiffness * (x - this.#to) - this.#damping * v) / this.#mass) * (dt / steps);
      x += v * (dt / steps);
    }
    if (Math.abs(x - this.#to) < this.#restDelta && Math.abs(v) < this.#restDelta * 10) {
      this.current = this.#to;
      this.#velocity = 0;
      this.#frame = 0;
    } else {
      this.current = x;
      this.#velocity = v;
      this.#frame = requestAnimationFrame(this.#tick);
    }
    this.#onChange();
  };
}

const TILT_MAX = 12;
const HOVER_SCALE = 1.03;
const FLING = 0.16;
const HISTORY_MS = 90;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const snap = (deg: number) => Math.round(deg / 180) * 180;
const isBack = (deg: number) => Math.abs(Math.round(deg / 180)) % 2 === 1;

export default function FlipCard({
  flipped = false,
  onFlippedChange,
  front,
  back,
  className = "",
}: {
  flipped?: boolean;
  onFlippedChange?: (flipped: boolean) => void;
  front: ReactNode;
  back: ReactNode;
  className?: string;
}) {
  const reduce = !!useReducedMotion();
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const target = useRef(flipped ? 180 : 0);
  const [springs] = useState(() => ({
    turn: new Spring(target.current, rerender, 170, 20, 1, 0.05),
    tiltX: new Spring(0, rerender, 240, 24, 0.6),
    tiltY: new Spring(0, rerender, 240, 24, 0.6),
    lift: new Spring(1, rerender, 320, 26),
  }));
  const { turn, tiltX, tiltY, lift } = springs;
  const [dragging, setDragging] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const grip = useRef<{
    id: number;
    x: number;
    base: number;
    moved: boolean;
    slop: number;
    history: { t: number; v: number }[];
  } | null>(null);

  const facing = Math.abs(Math.cos((turn.current * Math.PI) / 180));

  function settle(to: number, velocity: number, instant: boolean) {
    target.current = to;
    if (instant || reduce) turn.jump(to);
    else turn.set(to, velocity);
    onFlippedChange?.(isBack(to));
  }

  function flip(instant: boolean) {
    const base = snap(turn.current);
    settle(isBack(base) ? base - 180 : base + 180, 0, instant);
  }

  function rest() {
    tiltX.set(0);
    tiltY.set(0);
    lift.set(1);
  }

  // Follows flips made from outside, such as the deck's Space shortcut.
  useEffect(() => {
    if (isBack(target.current) === flipped) return;
    target.current = isBack(target.current) ? target.current - 180 : target.current + 180;
    if (reduce) turn.jump(target.current);
    else turn.set(target.current);
  }, [flipped]);

  useEffect(
    () => () => {
      for (const spring of Object.values(springs)) spring.stop();
    },
    [springs],
  );

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || grip.current) return;
    root.current!.setPointerCapture(event.pointerId);
    turn.stop();
    grip.current = {
      id: event.pointerId,
      x: event.clientX,
      base: turn.current,
      moved: false,
      slop: event.pointerType === "touch" ? 8 : 4,
      history: [],
    };
    if (!reduce) lift.set(HOVER_SCALE);
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    const rect = root.current!.getBoundingClientRect();
    const g = grip.current;
    if (g && g.id === event.pointerId) {
      const distance = event.clientX - g.x;
      if (!g.moved) {
        if (Math.abs(distance) < g.slop || reduce) return;
        g.moved = true;
        setDragging(true);
        tiltX.set(0);
        tiltY.set(0);
      }
      const deg = g.base + (distance / rect.width) * 180;
      turn.jump(deg);
      const now = performance.now();
      g.history.push({ t: now, v: deg });
      while (g.history.length > 2 && now - g.history[0].t > HISTORY_MS) g.history.shift();
      return;
    }
    if (reduce || event.pointerType === "touch") return;
    const px = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    const py = clamp((event.clientY - rect.top) / rect.height, 0, 1);
    tiltX.set((0.5 - py) * 2 * TILT_MAX);
    tiltY.set((px - 0.5) * 2 * TILT_MAX);
  }

  function release(event: PointerEvent<HTMLDivElement>, cancelled: boolean) {
    const g = grip.current;
    const node = root.current!;
    if (!g || g.id !== event.pointerId) return;
    grip.current = null;
    if (node.hasPointerCapture(event.pointerId)) node.releasePointerCapture(event.pointerId);
    setDragging(false);
    if (event.pointerType === "touch" || !node.matches(":hover")) rest();
    if (!g.moved) {
      if (cancelled) settle(target.current, 0, false);
      else flip(false);
      return;
    }
    const here = turn.current;
    let velocity = 0;
    const a = g.history[0];
    const b = g.history[g.history.length - 1];
    if (!cancelled && a && b && b.t > a.t && performance.now() - b.t < 60) velocity = ((b.v - a.v) / (b.t - a.t)) * 1000;
    const to = cancelled ? snap(g.base) : clamp(snap(here + velocity * FLING), snap(here) - 180, snap(here) + 180);
    settle(to, velocity, false);
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    if (!event.repeat) flip(true);
  }

  return (
    <div
      ref={root}
      role="button"
      tabIndex={0}
      aria-pressed={flipped}
      aria-label="Flip Card"
      title="Flip Card"
      className={`group relative cursor-grab touch-pan-y outline-none select-none data-dragging:cursor-grabbing ${className}`}
      data-dragging={dragging || undefined}
      data-fade={reduce ? (flipped ? "back" : "front") : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(event) => release(event, false)}
      onPointerCancel={(event) => release(event, true)}
      onLostPointerCapture={(event) => release(event, true)}
      onPointerEnter={(event) => {
        if (!reduce && event.pointerType !== "touch") lift.set(HOVER_SCALE);
      }}
      onPointerLeave={() => {
        if (!grip.current) rest();
      }}
      onKeyDown={onKeyDown}
      onClick={(event) => {
        if (event.detail === 0) flip(true);
      }}
      onDragStart={(event) => event.preventDefault()}
    >
      <span
        className="pointer-events-none absolute [inset:12%_9%_-5%] rounded-3xl bg-black/45 blur-[22px]"
        aria-hidden="true"
        style={{ transform: `scaleX(${0.08 + 0.92 * facing})`, opacity: 0.1 + 0.9 * facing * facing }}
      ></span>
      <div
        className="absolute inset-0 transform-3d"
        style={{
          transform: reduce
            ? undefined
            : `perspective(1100px) scale(${lift.current}) rotateX(${tiltX.current}deg) rotateY(${turn.current + tiltY.current}deg)`,
        }}
      >
        <div className="flip-face" aria-hidden={flipped} inert={flipped}>
          {front}
        </div>
        <div className="flip-face [transform:rotateY(180deg)] group-data-fade:transform-none!" aria-hidden={!flipped} inert={!flipped}>
          {back}
        </div>
      </div>
    </div>
  );
}
