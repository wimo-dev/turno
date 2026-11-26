import {
  Exit,
  type FlagSpec,
  type Io,
  JSON_FLAG,
  bool,
  emit,
  fail,
  jsonOutput,
  parseFlags,
  style,
} from "turno-core/cli";
import type { BrowserFunctions } from "../api.js";
import { type Ctx, openInBrowser } from "./context.js";
import { needIdentity } from "./flows.js";

/**
 * `live|pause|resume <id>`: the live view and take-over of the turno-browser-mcp
 * that serves an identity (turno-browser's `live-server.ts`). The view opens as an app window of
 * the person's Chromium browser (`--tab`: a tab of the default browser) through a link that
 * works once; the link is never printed.
 */

type LiveStatus = NonNullable<Awaited<ReturnType<BrowserFunctions["liveStatus"]>>>;

/** `live|pause|resume <id> --json`. */
export const LIVE_JSON = jsonOutput([
  "identity",
  "pid",
  "port",
  "started",
  "paused",
  "waiting",
  "busy",
  "wait",
  "browser",
  "engine",
  "view",
  "showing",
  "pinned",
  "hidden",
  "viewers",
  "tabs",
  "stuck",
]);

/** `120000` as "2m", `90000` as "90s". */
function seconds(ms: number): string {
  return ms >= 60_000 && ms % 60_000 === 0 ? `${ms / 60_000}m` : `${Math.round(ms / 1000)}s`;
}

/** Why there is no live view to talk to: off, or no server running now. */
function notServing(c: Ctx, id: string, io: Io): number {
  // On unless identity.json turns it off.
  const on = c.api.checkIdentitySettings(id, io.env).settings?.live?.enabled !== false;
  return fail(
    on
      ? `no turno-browser-mcp serves "${id}" right now. The live view starts with the server (an agent session that uses browser-${id} starts it).`
      : `the live view is off for "${id}". Turn it on with ${c.names.browser} set ${id} --live true; it starts with the next turno-browser-mcp for this identity.`,
  );
}

function describe(status: LiveStatus, io: Io): void {
  const s = style(io);
  const state = status.paused
    ? `paused for ${seconds(Math.max(0, Date.now() - Date.parse(status.paused.since)))} (${status.paused.by})${status.waiting ? `, ${status.waiting} call${status.waiting === 1 ? "" : "s"} waiting` : ""}`
    : status.busy
      ? "the agent is working"
      : "the agent is idle";
  io.out(`${s.bold(status.identity)}  ${state}`);
  io.out(
    s.muted(
      `  browser ${status.browser ? `running (${status.engine})` : "not running"}; a paused call waits up to ${seconds(status.wait)}`,
    ),
  );
  if (!status.view.available && status.view.reason) io.out(s.note("info", status.view.reason, 2));
  for (const t of status.tabs)
    io.out(
      `  ${t.id === status.showing ? "*" : " "} ${t.title || "(no title)"}  ${s.muted(t.url)}${t.session ? s.muted(` [${t.session}]`) : ""}`,
    );
}

const LIVE_FLAGS: FlagSpec = { "no-open": { type: "boolean" }, tab: { type: "boolean" }, ...JSON_FLAG };

export async function live(c: Ctx, args: string[], io: Io): Promise<number> {
  const mod = c.api;
  const open = c.deps.openUrl ?? openInBrowser;
  const p = parseFlags(args, LIVE_FLAGS, 1);
  const id = needIdentity(c, p.positionals[0], "live", io);
  const status = await mod.liveStatus(id, io.env);
  if (!status) return notServing(c, id, io);
  if (bool(p, "json")) {
    emit(io, p, LIVE_JSON, status);
    return Exit.ok;
  }
  describe(status, io);
  if (!status.view.available || bool(p, "no-open")) return Exit.ok;
  // An app window by default: the view sits next to the agent's Chrome like a side panel.
  const app = !bool(p, "tab");
  await open(await mod.liveLink(id, io.env), io, { app });
  io.err(
    style(io).muted(
      `opened the live view of "${id}" ${app ? "in an app window of your browser" : "in your browser"} (the link works once; run this again for a new one)`,
    ),
  );
  return Exit.ok;
}

export async function pause(c: Ctx, args: string[], io: Io): Promise<number> {
  const mod = c.api;
  const p = parseFlags(args, JSON_FLAG, 1);
  const id = needIdentity(c, p.positionals[0], "pause", io);
  if (!(await mod.liveStatus(id, io.env))) return notServing(c, id, io);
  const status = await mod.livePause(id, io.env);
  if (bool(p, "json")) {
    emit(io, p, LIVE_JSON, status);
    return Exit.ok;
  }
  io.out(
    `paused "${id}": the agent's next call waits up to ${seconds(status.wait)} for you. Act in the browser${status.view.available ? ` or the live view (${c.names.browser} live ${id})` : ""}, then: ${c.names.browser} resume ${id}`,
  );
  return Exit.ok;
}

export async function resume(c: Ctx, args: string[], io: Io): Promise<number> {
  const mod = c.api;
  const p = parseFlags(args, JSON_FLAG, 1);
  const id = needIdentity(c, p.positionals[0], "resume", io);
  const before = await mod.liveStatus(id, io.env);
  if (!before) return notServing(c, id, io);
  const status = await mod.liveResume(id, io.env);
  if (bool(p, "json")) {
    emit(io, p, LIVE_JSON, status);
    return Exit.ok;
  }
  io.out(
    before?.paused
      ? `resumed "${id}": the agent's waiting calls go on, and each is told what changed.`
      : `"${id}" was not paused.`,
  );
  return Exit.ok;
}
