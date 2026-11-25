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
import { type ActKey, describeAct } from "../act-chain.js";
import { type Effective, type EffectiveSettings, SAID_APART, defaultLines } from "../defaults.js";
import { effectiveSettings, exitProblems, proxyInUse } from "../effective.js";
import { type SystemProxy, systemProxy } from "../system-proxy.js";
import { captchaJson, describePolicy, localTime } from "./identity.js";

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

/** What identity.json sets, with the defaults filled in (`defaults.ts`), for `status`. */
function settingsSummary(
  s: Settings | undefined,
  e: EffectiveSettings,
  id: string,
  env: NodeJS.ProcessEnv,
  system: () => SystemProxy | undefined,
) {
  const inUse = proxyInUse(s, e, env, system);
  const on = (v: Effective<unknown>) => v.value !== undefined && v.value !== false && v.value !== "off";
  const act = describeAct(s?.act as ActKey, env);
  const captcha = captchaJson(s?.captcha, env);
  return {
    timezone: s?.timezone ?? null,
    languages: s?.languages ?? null,
    engine: s?.attach !== undefined ? "attach" : (s?.engine ?? "chrome"),
    sharing: e.sharing.value ?? "tabs",
    humanize: e.humanize.value ?? "auto",
    cursor: s?.cursor ?? "auto",
    /** "auto" until a launch reads the memory pressure. */
    resources: e.resources.value ?? "auto",
    keychain: e.keychain.value ?? "mock",
    live: e.live.value === true,
    record: {
      flows: on(e.record.flows),
      traces: e.record.traces.value ?? false,
      screenshots: on(e.record.screenshots),
    },
    /** Whether natural language actions are on, the model they resolve to, and why. */
    act: act.path !== "off",
    actProvider: act,
    /** Whether a captcha solver key is configured, where from, and why. */
    captcha: on(e.captcha),
    captchaSolver: captcha,
    proxy: (s?.proxy || undefined)?.server ?? null,
    /** The system's proxy, when the identity has none of its own and Chrome follows it. */
    systemProxy: inUse?.system ?? null,
    /** What the last exit lookup through the proxy found wrong (time zone, locale). */
    exitProblems: exitProblems(id, s, e, inUse?.server, env),
    health: (e.health.value || undefined)?.url ?? null,
    /** The values identity.json leaves to their defaults, with where each comes from (act and captcha above). */
    defaults: defaultLines(e, undefined, SAID_APART),
    /** identity.json `policy` as written: allowed hosts, disabled features, auto submit. */
    policy: s?.policy ?? null,
  };
}

/** The settings summary in one line. */
function settingsLine(s: ReturnType<typeof settingsSummary>): string {
  const parts = [
    s.timezone ? `time zone ${s.timezone}` : "the system's time zone",
    s.languages ? `languages ${s.languages.join(", ")}` : "",
    s.engine === "chrome" ? "" : `engine ${s.engine}`,
    s.sharing === "tabs" ? "every session at once, in its own tabs" : "one session at a time",
    s.resources === "low"
      ? "low-resource preset"
      : s.resources === "auto"
        ? "low-resource preset under memory pressure"
        : "",
    s.humanize === "off" ? "" : `humanize ${s.humanize}`,
    s.keychain === "system" ? "cookie key in the system keychain" : "",
    s.live ? "live view on" : "",
    Object.entries(s.record)
      .filter(([, on]) => on)
      .map(([k, v]) => (v === "failed" ? `records ${k} (kept when a step fails)` : `records ${k}`))
      .join(", "),
    s.proxy ? `proxy ${s.proxy}` : s.systemProxy ? `the system's proxy ${s.systemProxy}` : "",
    ...s.exitProblems.map((p) => `warning: ${p}`),
    s.policy ? `policy: ${describePolicy(s.policy)}` : "",
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
  // Read once for every identity: each one without a proxy of its own follows it.
  let read: { value: SystemProxy | undefined } | undefined;
  const system = () => {
    read ??= { value: systemProxy(process.platform, env) };
    return read.value;
  };
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
      settings: settingsSummary(settings, effectiveSettings(id, { env, systemProxy: system }), id, env, system),
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
    rows.push([
      "defaults",
      only === undefined
        ? s.muted(
            `${i.settings.defaults.length} values not in identity.json (${c.names.browser} status ${i.id} lists them)`,
          )
        : i.settings.defaults.join("; "),
    ]);
    rows.push([
      "act",
      `${i.settings.act ? i.settings.actProvider.label : "off"} ${s.muted(`(${i.settings.actProvider.reason})`)}`,
    ]);
    rows.push([
      "captcha",
      i.settings.captcha
        ? i.settings.captchaSolver.label
        : `a person answers (browser_request_human) ${s.muted(`(${i.settings.captchaSolver.reason})`)}`,
    ]);
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
