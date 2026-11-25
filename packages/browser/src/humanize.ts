/**
 * Human-like input, the planning half: where the pointer goes and when, how long a key or a
 * button stays down, how a scroll breaks into wheel notches. Pure functions of a seeded random
 * source, so a test with a seed gets the same plan every run; `human-input.ts` plays a plan on a
 * page.
 *
 * Levels (identity.json `humanize.level`, `auto` by default):
 *
 * - `off`: Playwright's own input, as before: one `mousemove` to the exact center of the target,
 *   button down and up at once, text inserted in one go.
 * - `light`: the pointer travels a curve from where it last was to a point inside the target, at
 *   a steady pace with small timing jitter; the button stays down for tens of milliseconds;
 *   short text is typed key by key with per-key delays.
 * - `full`: `light` plus a duration that grows with distance and shrinks with target size
 *   (Fitts' law), a slow-fast-slow speed profile, overshoot and correction on long moves, a
 *   short pause to read a page the first time it is acted on, longer pauses between words, and
 *   scrolling to an element out of view in wheel notches instead of one jump.
 * - `adaptive`: `light`, and `full` on a site after the identity met a challenge page there (the
 *   reputation log, or this session).
 * - `auto` (the default since format 14): decided per action (`autoLevel`): `off` on this
 *   machine's own pages (localhost) and for steps that only look (hover, pointer moves, scrolls),
 *   `full` on sign-in, payment and support pages and on sites that showed a challenge, `light`
 *   for every other interaction. Humanizing costs time (0.4 to 2 s an action at `light`), so it
 *   goes where a site watches the input and stays out of the way elsewhere.
 *
 * The numbers come from published measurements: a mouse move to a 20 px target 630 px away takes
 * a person about 750-850 ms; the average typist types 52 words a minute (about 230 ms a
 * character, the fast ones about 100 ms); a button press lasts tens of milliseconds to about 150.
 * Typing faster than a few milliseconds a key is physically impossible, so long text is pasted
 * instead (`MAX_TYPED`), like a person pasting it.
 */

export type HumanizeLevel = "off" | "light" | "full" | "adaptive" | "auto";

/** The levels a single action runs at, once `adaptive` is resolved. */
export type ActionLevel = "off" | "light" | "full";

export const HUMANIZE_LEVELS: readonly HumanizeLevel[] = ["off", "light", "full", "adaptive", "auto"];

/** Host names of this machine: humanizing input for one's own dev server buys nothing. */
function isLocalHost(host: string): boolean {
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "[::1]" ||
    host === "::1" ||
    /^127(\.\d{1,3}){3}$/.test(host)
  );
}

/**
 * Pages where a site watches the input most: signing in, paying, and asking support, by the
 * words their URLs carry (`/login`, `accounts.example.com/signin`, `/checkout`, `/support`).
 */
const WATCHED_PAGE =
  /(^|[./_-])(log-?in|sign-?in|signon|auth|oauth|sso|accounts?|checkout|payments?|pay|billing|cart|support|help|contact)([./_-]|$)/i;

/**
 * The level `auto` gives one action: `off` on localhost, `full` on sign-in, payment and support
 * pages and on sites that showed a challenge, else `off` for a step that only looks (`readOnly`)
 * and `light` for one that acts.
 */
export function autoLevel(url: string, challenged: ReadonlySet<string>, readOnly: boolean): ActionLevel {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return readOnly ? "off" : "light";
  }
  if (isLocalHost(parsed.hostname)) return "off";
  if (challenged.has(parsed.hostname) || WATCHED_PAGE.test(`${parsed.hostname}${parsed.pathname}`)) return "full";
  return readOnly ? "off" : "light";
}

/** identity.json `humanize`. */
export interface HumanizeSettings {
  level: HumanizeLevel;
  /** Makes every plan repeatable (tests, debugging). Without it each session draws its own. */
  seed?: number;
}

/** Text longer than this is pasted (Playwright's `fill`), not typed. */
export const MAX_TYPED = 80;

export interface Point {
  x: number;
  y: number;
}

export interface Box extends Point {
  width: number;
  height: number;
}

/** One pointer position, reached `wait` ms after the previous one. */
export interface Step extends Point {
  wait: number;
}

/** A seeded source of random numbers (mulberry32): small, fast and the same on every platform. */
export class Rng {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** A number in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  /** A normal draw (Box-Muller), clamped to [min, max]. */
  normal(mean: number, sd: number, min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY): number {
    const u = 1 - this.next();
    const v = this.next();
    const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    return Math.min(max, Math.max(min, mean + sd * z));
  }
}

/** A 32-bit FNV-1a hash, for a seed from a name. */
export function hashSeed(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * The stable traits of one identity's "hand": the same identity moves and types at the same
 * pace in every session (a person whose rhythm changed from one day to the next would stand out
 * more than one who is a little slow).
 */
export interface Persona {
  /** Scales pointer speed: above 1 is faster. */
  speed: number;
  /** Mean time between two keys, in ms. */
  keyMs: number;
  /** Which way the pointer's curves tend to bend: 1 or -1. */
  bend: 1 | -1;
}

export function personaFor(seed: number): Persona {
  const rng = new Rng(seed ^ 0x9e3779b9);
  return {
    speed: Number(rng.range(0.85, 1.2).toFixed(3)),
    keyMs: Math.round(rng.range(120, 190)),
    bend: rng.chance(0.5) ? 1 : -1,
  };
}

const STEP_MS = 16;

function bezier(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y };
}

/** Minimum-jerk position profile: slow start, fast middle, slow end. */
const minimumJerk = (t: number) => t * t * t * (10 - 15 * t + 6 * t * t);

/** How long a move takes at each level, before the persona's speed. */
export function moveDuration(distance: number, targetWidth: number, level: "light" | "full", rng: Rng): number {
  if (distance < 1) return 0;
  if (level === "light") return Math.min(420, Math.max(90, 80 + 0.2 * distance)) * rng.range(0.85, 1.15);
  // Fitts' law, T = a + b log2(D / W + 1), with a and b in the range measured for a mouse.
  const bits = Math.log2(distance / Math.max(8, targetWidth) + 1);
  return (110 + 140 * bits) * rng.range(0.9, 1.15);
}

/**
 * A curve from `from` to `to`: a cubic Bezier whose control points bend to one side. The bend is
 * what a wrist pivoting makes: the path strays about a tenth to a sixth of the distance from the
 * straight line, so it is some 3 to 9% longer than that line (a path within 1% of it, as an
 * earlier version drew, reads as a straight line).
 */
function curve(from: Point, to: Point, duration: number, level: "light" | "full", rng: Rng, persona: Persona): Step[] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  if (distance < 1 || duration <= 0) return [{ x: to.x, y: to.y, wait: 0 }];
  const nx = -dy / distance;
  const ny = dx / distance;
  const spread = Math.min(180, distance * (level === "full" ? 0.34 : 0.3));
  const side = rng.chance(0.75) ? persona.bend : -persona.bend;
  const c1 = rng.range(0.15, 0.45);
  const c2 = rng.range(0.55, 0.85);
  // Both control points on the same side: one smooth arc, never an S.
  const h1 = rng.range(0.55, 1) * spread;
  const h2 = rng.range(0.25, 0.75) * spread;
  const p1 = { x: from.x + dx * c1 + nx * side * h1, y: from.y + dy * c1 + ny * side * h1 };
  const p2 = { x: from.x + dx * c2 + nx * side * h2, y: from.y + dy * c2 + ny * side * h2 };
  const count = Math.max(4, Math.round(duration / STEP_MS));
  const steps: Step[] = [];
  for (let i = 1; i <= count; i++) {
    const t = i / count;
    const p = bezier(from, p1, p2, to, level === "full" ? minimumJerk(t) : t);
    // A little hand tremor on the way, never on the last point.
    const jitter = level === "full" && i < count ? 0.6 : 0;
    steps.push({
      x: p.x + (jitter ? rng.normal(0, jitter) : 0),
      y: p.y + (jitter ? rng.normal(0, jitter) : 0),
      wait: (duration / count) * rng.range(0.8, 1.2),
    });
  }
  return steps;
}

/**
 * The pointer path from `from` to `to` (which ends exactly on `to`), with the wait before each
 * position. `targetWidth` is the smaller side of the target, for Fitts' law.
 */
export function planMove(
  from: Point,
  to: Point,
  targetWidth: number,
  level: "light" | "full",
  rng: Rng,
  persona: Persona,
): Step[] {
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  if (distance < 1) return [];
  const duration = moveDuration(distance, targetWidth, level, rng) / persona.speed;
  if (level === "full" && distance > 250 && rng.chance(0.7)) {
    // Overshoot: the fast first movement lands past the target, a short second one corrects.
    const ux = (to.x - from.x) / distance;
    const uy = (to.y - from.y) / distance;
    const past = Math.min(40, distance * rng.range(0.03, 0.07));
    const sideways = rng.normal(0, past / 3);
    const over = { x: to.x + ux * past - uy * sideways, y: to.y + uy * past + ux * sideways };
    const first = curve(from, over, duration * 0.85, level, rng, persona);
    const back = curve(over, to, rng.range(90, 170) / persona.speed, "light", rng, persona);
    const [start, ...rest] = back;
    if (start) start.wait += rng.range(40, 110); // the eye sees the miss before the hand corrects
    return [...first, ...(start ? [start] : []), ...rest];
  }
  return curve(from, to, duration, level, rng, persona);
}

/**
 * A point inside the box: near the middle, never the exact center and never on the edge (a
 * person aims at the visible middle of a button, and lands a few pixels off).
 */
export function pickPoint(box: Box, rng: Rng): Point {
  const fx = rng.normal(0.5, 0.12, 0.2, 0.8);
  const fy = rng.normal(0.5, 0.12, 0.25, 0.75);
  return { x: box.x + box.width * fx, y: box.y + box.height * fy };
}

/** A pause, in ms, at each level. */
export interface Timing {
  /** Between arriving on the target and pressing the button. */
  beforePress: number;
  /** Button held down. */
  press: number;
}

export function clickTiming(level: "light" | "full", rng: Rng): Timing {
  if (level === "light") return { beforePress: rng.range(10, 50), press: rng.range(40, 90) };
  return { beforePress: rng.range(60, 200), press: rng.normal(90, 25, 45, 170) };
}

/** A pause to look at a page acted on for the first time (`full` only). */
export function readingPause(rng: Rng): number {
  return rng.range(250, 800);
}

/** How long a key stays down, in ms. */
export function keyHold(level: "light" | "full", rng: Rng): number {
  return level === "light" ? rng.range(30, 70) : rng.normal(75, 20, 35, 140);
}

/**
 * The wait before each character of `text` (the first one included: the hand moves to the
 * keyboard), in ms. `light`: the persona's pace with jitter. `full`: a skewed draw around the
 * pace, faster inside a word than across a space, longer after punctuation, and now and then a
 * pause to think.
 */
export function keyDelays(text: string, level: "light" | "full", rng: Rng, persona: Persona): number[] {
  const chars = [...text];
  const out: number[] = [];
  for (let i = 0; i < chars.length; i++) {
    const prev = i ? chars[i - 1]! : "";
    if (level === "light") {
      out.push(persona.keyMs * rng.range(0.6, 1.3) * 0.8);
      continue;
    }
    // A log-normal draw: most keys near the pace, a long tail of slower ones.
    let wait = persona.keyMs * Math.exp(rng.normal(-0.1, 0.35, -1, 1.2));
    if (prev === " ") wait += rng.range(40, 160);
    else if (/[.,;:!?]/.test(prev)) wait += rng.range(120, 300);
    if (i === 0) wait += rng.range(80, 200);
    else if (rng.chance(0.03)) wait += rng.range(300, 800);
    out.push(wait);
  }
  return out;
}

/** One wheel event and the wait before it. */
export interface WheelStep {
  dx: number;
  dy: number;
  wait: number;
}

/**
 * A scroll of (dx, dy) in wheel notches of about 100 px, in short bursts with a pause between
 * them, the way a mouse wheel turns (`full`). The notches add up to exactly (dx, dy).
 */
export function planWheel(dx: number, dy: number, rng: Rng): WheelStep[] {
  const total = Math.max(Math.abs(dx), Math.abs(dy));
  if (total === 0) return [];
  const count = Math.max(1, Math.round(total / 100));
  const out: WheelStep[] = [];
  let burst = Math.round(rng.range(2, 6));
  let sentX = 0;
  let sentY = 0;
  for (let i = 1; i <= count; i++) {
    const x = Math.round((dx * i) / count) - sentX;
    const y = Math.round((dy * i) / count) - sentY;
    sentX += x;
    sentY += y;
    let wait = rng.range(25, 70);
    if (--burst === 0) {
      wait += rng.range(120, 350);
      burst = Math.round(rng.range(2, 6));
    }
    out.push({ dx: x, dy: y, wait: i === 1 ? rng.range(20, 60) : wait });
  }
  return out;
}

/** The total time of a plan, in ms. */
export function planTime(steps: readonly { wait: number }[]): number {
  return steps.reduce((sum, s) => sum + s.wait, 0);
}
