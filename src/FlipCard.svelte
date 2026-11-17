<!-- Svelte port of React Bits' Flip Card (reactbits.dev/micro/flip-card): flips in 3D on a click, drag or flick. -->
<script lang="ts">
  import type { Snippet } from "svelte";
  import { prefersReducedMotion } from "svelte/motion";

  let {
    flipped = $bindable(false),
    front,
    back,
    class: className = "",
  }: { flipped?: boolean; front: Snippet; back: Snippet; class?: string } = $props();

  /** A damped spring like Motion's: stiffness, damping and mass in physical units, with optional starting velocity. */
  class Spring {
    current = $state(0);
    #to = 0;
    #velocity = 0;
    #frame = 0;
    #last = 0;
    #stiffness: number;
    #damping: number;
    #mass: number;
    #restDelta: number;

    constructor(value: number, stiffness: number, damping: number, mass = 1, restDelta = 0.001) {
      this.current = this.#to = value;
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
        return;
      }
      this.current = x;
      this.#velocity = v;
      this.#frame = requestAnimationFrame(this.#tick);
    };
  }

  const TILT_MAX = 12;
  const HOVER_SCALE = 1.03;
  const FLING = 0.16;
  const HISTORY_MS = 90;

  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  const snap = (deg: number) => Math.round(deg / 180) * 180;
  const isBack = (deg: number) => Math.abs(Math.round(deg / 180)) % 2 === 1;

  const reduce = $derived(prefersReducedMotion.current);
  // svelte-ignore state_referenced_locally
  let target = flipped ? 180 : 0;
  const turn = new Spring(target, 170, 20, 1, 0.05);
  const tiltX = new Spring(0, 240, 24, 0.6);
  const tiltY = new Spring(0, 240, 24, 0.6);
  const lift = new Spring(1, 320, 26);
  let dragging = $state(false);
  let root: HTMLDivElement;
  let grip: {
    id: number;
    x: number;
    base: number;
    moved: boolean;
    slop: number;
    history: { t: number; v: number }[];
  } | null = null;

  const facing = $derived(Math.abs(Math.cos((turn.current * Math.PI) / 180)));

  function settle(to: number, velocity: number, instant: boolean) {
    target = to;
    if (instant || reduce) turn.jump(to);
    else turn.set(to, velocity);
    flipped = isBack(to);
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
  $effect(() => {
    if (isBack(target) === flipped) return;
    target = isBack(target) ? target - 180 : target + 180;
    if (reduce) turn.jump(target);
    else turn.set(target);
  });

  $effect(() => () => {
    for (const spring of [turn, tiltX, tiltY, lift]) spring.stop();
  });

  function onpointerdown(event: PointerEvent) {
    if (event.button !== 0 || grip) return;
    root.setPointerCapture(event.pointerId);
    turn.stop();
    grip = {
      id: event.pointerId,
      x: event.clientX,
      base: turn.current,
      moved: false,
      slop: event.pointerType === "touch" ? 8 : 4,
      history: [],
    };
    if (!reduce) lift.set(HOVER_SCALE);
  }

  function onpointermove(event: PointerEvent) {
    const rect = root.getBoundingClientRect();
    if (grip && grip.id === event.pointerId) {
      const distance = event.clientX - grip.x;
      if (!grip.moved) {
        if (Math.abs(distance) < grip.slop || reduce) return;
        grip.moved = true;
        dragging = true;
        tiltX.set(0);
        tiltY.set(0);
          }
      const deg = grip.base + (distance / rect.width) * 180;
      turn.jump(deg);
      const now = performance.now();
      grip.history.push({ t: now, v: deg });
      while (grip.history.length > 2 && now - grip.history[0].t > HISTORY_MS) grip.history.shift();
      return;
    }
    if (reduce || event.pointerType === "touch") return;
    const px = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    const py = clamp((event.clientY - rect.top) / rect.height, 0, 1);
    tiltX.set((0.5 - py) * 2 * TILT_MAX);
    tiltY.set((px - 0.5) * 2 * TILT_MAX);
  }

  function release(event: PointerEvent, cancelled: boolean) {
    const g = grip;
    if (!g || g.id !== event.pointerId) return;
    grip = null;
    if (root.hasPointerCapture(event.pointerId)) root.releasePointerCapture(event.pointerId);
    dragging = false;
    if (event.pointerType === "touch" || !root.matches(":hover")) rest();
    if (!g.moved) {
      if (cancelled) settle(target, 0, false);
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

  function onkeydown(event: KeyboardEvent) {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    if (!event.repeat) flip(true);
  }
</script>

<div
  bind:this={root}
  role="button"
  tabindex="0"
  aria-pressed={flipped}
  aria-label="Flip Card"
  title="Flip Card"
  class="group relative cursor-grab touch-pan-y outline-none select-none data-dragging:cursor-grabbing {className}"
  data-dragging={dragging || undefined}
  data-fade={reduce ? (flipped ? "back" : "front") : undefined}
  {onpointerdown}
  {onpointermove}
  onpointerup={(event) => release(event, false)}
  onpointercancel={(event) => release(event, true)}
  onlostpointercapture={(event) => release(event, true)}
  onpointerenter={(event) => {
    if (!reduce && event.pointerType !== "touch") lift.set(HOVER_SCALE);
  }}
  onpointerleave={() => {
    if (!grip) rest();
  }}
  {onkeydown}
  onclick={(event) => {
    if (event.detail === 0) flip(true);
  }}
  ondragstart={(event) => event.preventDefault()}
>
  <span
    class="pointer-events-none absolute [inset:12%_9%_-5%] rounded-3xl bg-black/45 blur-[22px]"
    aria-hidden="true"
    style:transform="scaleX({0.08 + 0.92 * facing})"
    style:opacity={0.1 + 0.9 * facing * facing}
  ></span>
  <div
    class="absolute inset-0 transform-3d"
    style:transform={reduce
      ? undefined
      : `perspective(1100px) scale(${lift.current}) rotateX(${tiltX.current}deg) rotateY(${turn.current + tiltY.current}deg)`}
  >
    <div class="face" aria-hidden={flipped} inert={flipped}>
      {@render front()}
    </div>
    <div class="face [transform:rotateY(180deg)] group-data-fade:transform-none!" aria-hidden={!flipped} inert={!flipped}>
      {@render back()}
    </div>
  </div>
</div>

<style>
  .face {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border-radius: var(--radius-3xl);
    background: var(--note);
    backface-visibility: hidden;
  }

  [data-fade] .face {
    opacity: 0;
    backface-visibility: visible;
    transition: opacity 200ms ease;
  }

  [data-fade="front"] .face:first-child,
  [data-fade="back"] .face:last-child {
    opacity: 1;
  }
</style>
