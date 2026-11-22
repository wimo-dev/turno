import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Exit, type Io, JSON_FLAG, bool, emit, fail, jsonOutput, parseFlags, style } from "turno-core/cli";
import { tildify } from "turno-core/paths";
import { AGENTS, browserEntries, entryIdentity } from "../agent-mcp.js";
import { liveBackground } from "../background-state.js";
import { cookieHosts } from "../cookie-hosts.js";
import { readLastUsed } from "../last-used.js";
import { vaultSummary } from "../vault.js";
import type { Ctx } from "./context.js";
import { localTime } from "./identity.js";

/**
 * `status [<id>] [--json]`: one look at what turno-browser has on this machine. For each
 * identity: its profile, a summary of its settings and policies, who holds it, the sites it is
 * signed in to (the last sign-in by hand, and the host names of the profile's cookies, never
 * their values), when it last served a call, and which agents have it. It only reads.
 */

/** `status --json`: the version and one element per identity. */
export const STATUS_JSON = jsonOutput(["version", "identities"]);

const VERSION = (
  JSON.parse(readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8")) as { version: string }
).version;

type Settings = NonNullable<ReturnType<Ctx["api"]["checkIdentitySettings"]>["settings"]>;

/** What identity.json sets, with the defaults filled in, for `status`. */
function settingsSummary(s: Settings | undefined) {
  return {
    timezone: s?.timezone ?? null,
    languages: s?.languages ?? null,
    engine: s?.attach !== undefined ? "attach" : (s?.engine ?? "chrome"),
    sharing: s?.sharing ?? "session",
    humanize: s?.humanize?.level ?? "off",
    cursor: s?.cursor ?? "auto",
    resources: s?.resources ?? "normal",
    keychain: s?.keychain ?? "mock",
    live: Boolean(s?.live?.enabled),
    record: {
      flows: Boolean(s?.record?.flows),
      traces: Boolean(s?.record?.traces),
      screenshots: Boolean(s?.record?.screenshots),
    },
    act: s?.act !== undefined,
    captcha: s?.captcha !== undefined,
    proxy: s?.proxy?.server ?? null,
    health: s?.health?.url ?? null,
  };
}

/** The settings summary in one line. */
function settingsLine(s: ReturnType<typeof settingsSummary>): string {
  const parts = [
    s.timezone ? `time zone ${s.timezone}` : "the system's time zone",
    s.languages ? `languages ${s.languages.join(", ")}` : "",
    s.engine === "chrome" ? "" : `engine ${s.engine}`,
    s.sharing === "tabs" ? "every session at once, in its own tabs" : "one session at a time",
    s.resources === "low" ? "low-resource preset" : "",
    s.humanize === "off" ? "" : `humanize ${s.humanize}`,
    s.keychain === "system" ? "cookie key in the system keychain" : "",
    s.live ? "live view on" : "",
    Object.entries(s.record)
      .filter(([, on]) => on)
      .map(([k]) => `records ${k}`)
      .join(", "),
    s.act ? "act on" : "",
    s.captcha ? "captcha solving on" : "",
    s.proxy ? `proxy ${s.proxy}` : "",
  ];
  return parts.filter(Boolean).join("; ");
}

const few = (list: readonly string[], n = 6) =>
  list.length > n ? `${list.slice(0, n).join(", ")} and ${list.length - n} more` : list.join(", ");

export async function status(c: Ctx, args: string[], io: Io): Promise<number> {
  const p = parseFlags(args, JSON_FLAG, 1);
  const m = c.api;
  const env = io.env;
  const only = p.positionals[0];
  if (only !== undefined) {
    try {
      m.assertIdentityId(only);
    } catch (err) {
      return fail((err as Error).message);
    }
    if (!m.identityExists(only, env))
      return fail(`identity "${only}" does not exist (${c.names.identity("add", only)})`);
  }
  const ids = m
    .listIdentities(env)
    .map((i) => i.id)
    .filter((id) => only === undefined || id === only);
  const { entries } = browserEntries(env);
  const identities = [];
  for (const id of ids) {
    const { path, settings, problems } = m.checkIdentitySettings(id, env);
    const holder = m.inUseBy(id, env);
    const inUse = m.isInUse(id, env);
    const background = liveBackground(id, env);
    const login = m.readLoginRecord(id, env);
    const vault = vaultSummary(id, env);
    const cookies = await cookieHosts(m.identityDir(id, env), inUse);
    identities.push({
      id,
      profile: tildify(m.identityDir(id, env), env),
      settingsFile: tildify(path, env),
      settings: settingsSummary(settings),
      problems,
      inUse,
      holder: holder ?? null,
      background: background ? { pid: background.pid, startedAt: background.startedAt } : null,
      vault: vault ? { sites: vault.sites, submit: vault.submit } : null,
      signedIn: login ? { at: login.at, sites: login.sites } : null,
      cookieHosts: "hosts" in cookies ? cookies.hosts : null,
      cookieNote: "note" in cookies ? cookies.note : null,
      lastUsed: readLastUsed(id, env) ?? null,
      agents: entries
        .filter((e) => entryIdentity(e) === id)
        .map((e) => ({ agent: e.agent, server: e.server, file: tildify(e.file, env) })),
    });
  }
  if (bool(p, "json")) {
    emit(io, p, STATUS_JSON, { version: VERSION, identities });
    return Exit.ok;
  }
  const s = style(io);
  io.out(`${s.bold("turno-browser")} ${VERSION}`);
  if (!identities.length) io.out(`No browser identities yet. Create one with ${c.names.identity("add", "<id>")}.`);
  for (const i of identities) {
    io.out("");
    const state = i.holder
      ? s.warn(i.holder.replace(/^browser identity "[^"]+" is /, "").replace(/\. .*$/, ""))
      : i.inUse
        ? s.warn("in use by a Chrome")
        : s.ok("not in use");
    io.out(`${s.bold(`browser:${i.id}`)}  ${state}`);
    const rows: [string, string][] = [
      ["profile", i.profile],
      [
        "settings",
        settingsLine(i.settings) + (i.problems.length ? s.err(` (identity.json: ${i.problems.join("; ")})`) : ""),
      ],
    ];
    if (i.background)
      rows.push(["background", `server pid ${i.background.pid} since ${localTime(i.background.startedAt)}`]);
    rows.push([
      "vault",
      i.vault
        ? i.vault.sites.length
          ? `${few(i.vault.sites)} (${i.vault.submit === "auto" ? "submits by itself" : "the agent submits"})`
          : s.muted("empty")
        : s.err("the index is unreadable"),
    ]);
    rows.push([
      "signed in",
      i.signedIn
        ? `${localTime(i.signedIn.at)} by hand${i.signedIn.sites.length ? `: ${few(i.signedIn.sites)}` : ""}`
        : s.muted(`never by hand (${c.names.identity("login", i.id)})`),
    ]);
    rows.push([
      "cookies",
      i.cookieHosts
        ? i.cookieHosts.length
          ? `${i.cookieHosts.length} site${i.cookieHosts.length === 1 ? "" : "s"}: ${few(i.cookieHosts)}`
          : s.muted("none")
        : s.muted(i.cookieNote ?? ""),
    ]);
    rows.push(["last used", i.lastUsed ? localTime(i.lastUsed) : s.muted("not since this was kept")]);
    rows.push([
      "agents",
      i.agents.length
        ? i.agents.map((a) => `${AGENTS[a.agent].label} (${a.file})`).join(", ")
        : s.muted(
            c.names.subject === ""
              ? `none found here (${c.names.browser} setup <agent> --identity ${i.id})`
              : "none found here",
          ),
    ]);
    const width = Math.max(...rows.map(([k]) => k.length));
    for (const [k, v] of rows) io.out(s.kv(k, v, width));
  }
  return Exit.ok;
}
