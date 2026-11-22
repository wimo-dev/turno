import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ChallengeKind, classifyChallenge } from "./detectors.js";
import { IdentityError, identityStateDir } from "./ids.js";
import { identityExists, listIdentities } from "./identities.js";

/**
 * The reputation log: every challenge a page of an identity showed, one JSON line in
 * `<state>/browser/identities/<id>/reputation.jsonl`:
 *
 *     {"ts":"2026-11-17T16:00:00.000Z","site":"mail.example.com","kind":"verify","markers":["verify it's you"]}
 *
 * Only the host name and the matched phrases (from the fixed list in `detectors.ts`): no path,
 * no query, no page content. A site's reputation is not a score a test page gives; it is how
 * often the site stops the identity, and whether that goes up or down. `turno browser
 * reputation` shows the counts and the trend of the last 7 days against the 7 before.
 *
 * With captcha solving on (identity.json `captcha`), each attempt of `browser_solve_captcha`
 * is a line of its own, with the widget kind, the provider and whether it worked:
 *
 *     {"ts":"2026-11-19T16:00:00.000Z","site":"shop.example.com","kind":"solve","widget":"recaptcha","provider":"task-api","ok":true}
 *
 * An older turno-browser skips those lines when it reads the log.
 */

export interface ChallengeEvent {
  ts: string;
  site: string;
  kind: ChallengeKind;
  markers: string[];
}

/** One `browser_solve_captcha` attempt. Never the token, the key or the page's path. */
export interface SolveEvent {
  ts: string;
  site: string;
  kind: "solve";
  widget: string;
  provider: string;
  ok: boolean;
}

export interface SiteSummary {
  site: string;
  total: number;
  /** Captchas a solver answered (identity.json `captcha`); not counted in `total`. */
  solved: number;
  captcha: number;
  verify: number;
  block: number;
  last7d: number;
  prev7d: number;
  trend: "up" | "down" | "flat";
  lastSeen: string;
}

export interface IdentityReputation {
  id: string;
  file: string;
  total: number;
  sites: SiteSummary[];
}

/** The log keeps about this many bytes; older lines go first. */
const MAX_BYTES = 1024 * 1024;
const DAY = 86_400_000;

export function reputationPath(id: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(identityStateDir(id, env), "reputation.jsonl");
}

export function recordChallenge(
  id: string,
  env: NodeJS.ProcessEnv,
  event: Omit<ChallengeEvent, "ts">,
  now: Date = new Date(),
): void {
  appendLine(id, env, { ts: now.toISOString(), site: event.site, kind: event.kind, markers: event.markers });
}

/** Logs one captcha solving attempt. */
export function recordSolve(
  id: string,
  env: NodeJS.ProcessEnv,
  event: Omit<SolveEvent, "ts" | "kind">,
  now: Date = new Date(),
): void {
  const line: SolveEvent = {
    ts: now.toISOString(),
    site: event.site,
    kind: "solve",
    widget: event.widget,
    provider: event.provider,
    ok: event.ok,
  };
  appendLine(id, env, line);
}

function appendLine(id: string, env: NodeJS.ProcessEnv, line: ChallengeEvent | SolveEvent): void {
  const file = reputationPath(id, env);
  mkdirSync(identityStateDir(id, env), { recursive: true, mode: 0o700 });
  appendFileSync(file, `${JSON.stringify(line)}\n`, { mode: 0o600 });
  try {
    if (statSync(file).size > MAX_BYTES) {
      const lines = readFileSync(file, "utf8").trim().split("\n");
      writeFileSync(file, `${lines.slice(Math.floor(lines.length / 2)).join("\n")}\n`, { mode: 0o600 });
    }
  } catch {
    /* trimming is best effort */
  }
}

function isEvent(v: unknown): v is ChallengeEvent {
  const e = v as Partial<ChallengeEvent> | null;
  return (
    typeof e === "object" &&
    e !== null &&
    typeof e.ts === "string" &&
    typeof e.site === "string" &&
    (e.kind === "captcha" || e.kind === "verify" || e.kind === "block") &&
    Array.isArray(e.markers)
  );
}

function isSolve(v: unknown): v is SolveEvent {
  const e = v as Partial<SolveEvent> | null;
  return (
    typeof e === "object" &&
    e !== null &&
    e.kind === "solve" &&
    typeof e.ts === "string" &&
    typeof e.site === "string" &&
    typeof e.ok === "boolean"
  );
}

function readLines<T>(id: string, env: NodeJS.ProcessEnv, keep: (v: unknown) => v is T): T[] {
  let text: string;
  try {
    text = readFileSync(reputationPath(id, env), "utf8");
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line) as unknown;
      if (keep(v)) out.push(v);
    } catch {
      /* a torn or foreign line */
    }
  }
  return out;
}

/** Every challenge of the identity's log, oldest first. Lines that do not parse are skipped. */
export function readChallenges(id: string, env: NodeJS.ProcessEnv = process.env): ChallengeEvent[] {
  return readLines(id, env, isEvent);
}

/** Every captcha solving attempt of the identity's log, oldest first. */
export function readSolves(id: string, env: NodeJS.ProcessEnv = process.env): SolveEvent[] {
  return readLines(id, env, isSolve);
}

/** Counts per site, most recent first, with the trend of the last 7 days against the 7 before. */
export function summarizeChallenges(
  events: readonly ChallengeEvent[],
  now: Date = new Date(),
  solves: readonly SolveEvent[] = [],
): SiteSummary[] {
  const bySite = new Map<string, SiteSummary>();
  const t = now.getTime();
  const empty = (site: string, ts: string): SiteSummary => ({
    site,
    total: 0,
    solved: 0,
    captcha: 0,
    verify: 0,
    block: 0,
    last7d: 0,
    prev7d: 0,
    trend: "flat",
    lastSeen: ts,
  });
  for (const e of events) {
    const s = bySite.get(e.site) ?? empty(e.site, e.ts);
    s.total++;
    s[e.kind]++;
    const age = t - Date.parse(e.ts);
    if (age <= 7 * DAY) s.last7d++;
    else if (age <= 14 * DAY) s.prev7d++;
    if (e.ts > s.lastSeen) s.lastSeen = e.ts;
    bySite.set(e.site, s);
  }
  for (const e of solves) {
    if (!e.ok) continue;
    const s = bySite.get(e.site) ?? empty(e.site, e.ts);
    s.solved++;
    if (e.ts > s.lastSeen) s.lastSeen = e.ts;
    bySite.set(e.site, s);
  }
  for (const s of bySite.values()) s.trend = s.last7d > s.prev7d ? "up" : s.last7d < s.prev7d ? "down" : "flat";
  return [...bySite.values()].sort((a, b) => b.lastSeen.localeCompare(a.lastSeen) || a.site.localeCompare(b.site));
}

/** The report of `turno browser reputation`: the identities asked for, or every one. */
export function reputationReport(
  env: NodeJS.ProcessEnv = process.env,
  ids?: readonly string[],
  now: Date = new Date(),
): { identities: IdentityReputation[] } {
  const list = ids?.length ? [...ids] : listIdentities(env).map((i) => i.id);
  for (const id of list) if (!identityExists(id, env)) throw new IdentityError(`identity "${id}" does not exist`);
  return {
    identities: list.map((id) => {
      const events = readChallenges(id, env);
      return {
        id,
        file: reputationPath(id, env),
        total: events.length,
        sites: summarizeChallenges(events, now, readSolves(id, env)),
      };
    }),
  };
}

interface WatchedPage {
  url(): string;
  content(): Promise<string>;
  on(event: "load", listener: () => void): unknown;
  off?(event: "load", listener: () => void): unknown;
}

interface WatchedContext {
  pages(): WatchedPage[];
  on(event: "page", listener: (page: WatchedPage) => void): unknown;
  off?(event: "page", listener: (page: WatchedPage) => void): unknown;
}

export interface WatchOptions {
  /** The same site and kind within this long counts once (a reload loop). */
  dedupeMs?: number;
  now?: () => number;
  /**
   * Hears every check of a page load as it starts, with what it will find (any challenge, also
   * one the log counts once), so a tool result can say the page it ended on is one.
   */
  onCheck?: (page: WatchedPage, found: Promise<Omit<ChallengeEvent, "ts"> | undefined>) => void;
}

/**
 * Looks at every page the context loads (each main frame `load`, popups included) and reports
 * a challenge page: its host name, kind and matched phrases. Returns a function that stops.
 */
export function watchChallenges(
  context: WatchedContext,
  onChallenge: (event: Omit<ChallengeEvent, "ts">) => void,
  opts: WatchOptions = {},
): () => void {
  const dedupeMs = opts.dedupeMs ?? 60_000;
  const now = opts.now ?? Date.now;
  const last = new Map<string, number>();
  const listeners = new Map<WatchedPage, () => void>();
  let stopped = false;
  const inspect = async (page: WatchedPage): Promise<Omit<ChallengeEvent, "ts"> | undefined> => {
    let site: string;
    try {
      const url = new URL(page.url());
      if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
      site = url.hostname;
    } catch {
      return undefined;
    }
    const html = await page.content().catch(() => undefined);
    if (stopped || html === undefined) return undefined;
    const found = classifyChallenge(html);
    if (!found) return undefined;
    const event = { site, kind: found.kind, markers: found.markers };
    const key = `${site}\n${found.kind}`;
    const t = now();
    const previous = last.get(key);
    if (previous !== undefined && t - previous < dedupeMs) return event;
    last.set(key, t);
    onChallenge(event);
    return event;
  };
  const attach = (page: WatchedPage) => {
    if (listeners.has(page)) return;
    const listener = () => {
      const found = inspect(page).catch(() => undefined);
      opts.onCheck?.(page, found);
    };
    listeners.set(page, listener);
    page.on("load", listener);
  };
  for (const p of context.pages()) attach(p);
  context.on("page", attach);
  return () => {
    stopped = true;
    context.off?.("page", attach);
    for (const [page, listener] of listeners) page.off?.("load", listener);
    listeners.clear();
  };
}
