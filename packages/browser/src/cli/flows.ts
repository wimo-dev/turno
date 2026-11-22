import {
  DRY_RUN,
  Exit,
  type FlagSpec,
  type Io,
  JSON_FLAG,
  bool,
  emit,
  fail,
  jsonOutput,
  needsAnswer,
  noInputReason,
  parseFlags,
  str,
  style,
} from "turno-core/cli";
import { tildify } from "turno-core/paths";
import type { BrowserFunctions } from "../api.js";
import type { Ctx } from "./context.js";
import { describeRecord } from "./identity.js";
import { terminalInput } from "./vault.js";

/**
 * `flows|replay|traces|record`: the saved flows of an identity, running one
 * outside an agent, its recordings (traces and screenshots), and what it records. The flows and
 * recordings themselves are turno-browser's (`flows.ts`, `recordings.ts`); this file only shows
 * and drives them.
 */

/** `flows <id> --json`: one element per flow. */
export const FLOWS_JSON = jsonOutput(["name", "description", "steps", "params", "start", "auto", "updated", "file"]);
/** `replay --json`. */
export const REPLAY_JSON = jsonOutput(["identity", "flow", "ok", "report"]);
/** `traces <id> --json`: one element per recording. */
export const TRACES_JSON = jsonOutput([
  "name",
  "dir",
  "title",
  "started",
  "ended",
  "steps",
  "screenshots",
  "traces",
  "bytes",
  "notes",
]);
/** `record <id> --json`. */
export const RECORD_JSON = jsonOutput(["id", "dryRun", "record", "flowsDir", "recordingsDir"]);

type Flow = ReturnType<BrowserFunctions["readFlow"]>;

/** The identity a subcommand names, which must exist. */
export function needIdentity(c: Ctx, id: string | undefined, sub: string, io: Io): string {
  const n = c.names;
  if (!id) return fail(`${n.subject}${sub} needs an identity id (for example: ${n.browser} ${sub} school)`);
  c.api.assertIdentityId(id);
  if (!c.api.identityExists(id, io.env)) return fail(`identity "${id}" does not exist (${n.identity("add", id)})`);
  return id;
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

const FLOWS_FLAGS: FlagSpec = { remove: { type: "boolean" }, ...DRY_RUN, ...JSON_FLAG };

/** A flow's steps in a few words each (the package's own wording is in the tool; this mirrors it). */
function stepLine(step: Flow["steps"][number]): string {
  const t = step.targets?.target ?? step.targets?.startTarget;
  const a = step.args as Record<string, unknown>;
  if (step.tool === "browser_login") return `browser_login site "${String(a.site)}"`;
  if (step.tool === "browser_replay") return `browser_replay flow "${String(a.flow)}"`;
  const what = t ? (t.description ?? t.locators[0]?.selector) : (a.url ?? a.key ?? a.action ?? a.time);
  const text = a.text as { $param?: string } | undefined;
  return `${step.tool}${what === undefined ? "" : ` ${String(what)}`}${text?.$param ? ` with {${text.$param}}` : ""}`;
}

export function flows(c: Ctx, args: string[], io: Io): number {
  const mod = c.api;
  const p = parseFlags(args, FLOWS_FLAGS, 2);
  const id = needIdentity(c, p.positionals[0], "flows", io);
  const name = p.positionals[1];
  if (bool(p, "remove")) {
    if (!name) return fail(`--remove needs a flow name: ${c.names.browser} flows <id> <flow> --remove`);
    mod.readFlow(id, name, io.env);
    if (bool(p, "dry-run")) {
      io.out(`(dry run) would delete flow "${name}" of "${id}"`);
      return Exit.ok;
    }
    mod.removeFlow(id, name, io.env);
    io.out(`deleted flow "${name}" of "${id}"`);
    return Exit.ok;
  }
  const s = style(io);
  if (name) {
    const flow = mod.readFlow(id, name, io.env);
    if (bool(p, "json")) {
      io.out(JSON.stringify({ schemaVersion: 1, ...flow }, null, 2));
      return Exit.ok;
    }
    io.out(s.bold(`${flow.name}`) + (flow.description ? `  ${s.muted(flow.description)}` : ""));
    for (const [i, step] of flow.steps.entries()) io.out(`  ${String(i + 1).padStart(2)}. ${stepLine(step)}`);
    if (flow.params.length) {
      io.out("");
      io.out(s.header("Parameters"));
      for (const param of flow.params)
        io.out(
          `  ${param.name}  ${s.muted(param.sensitive ? "sensitive: give it at replay (keychain:<item>)" : param.default !== undefined ? "has a default" : "required")}`,
        );
    }
    return Exit.ok;
  }
  const list = mod.listFlows(id, io.env);
  if (bool(p, "json")) {
    emit(
      io,
      p,
      FLOWS_JSON,
      list.map((f) => ({ ...f, file: tildify(f.file, io.env) })),
    );
    return Exit.ok;
  }
  if (!list.length) {
    io.out(`No saved flows for "${id}". An agent records one with the browser_record tool.`);
    return Exit.ok;
  }
  const head = ["flow", "steps", "params", "updated"].map((h) => s.muted(h));
  const rows = list.map((f) => [
    f.auto ? s.muted(f.name) : f.name,
    String(f.steps),
    f.params.map((x) => `${x.name}${x.sensitive ? "*" : ""}`).join(", ") || "-",
    f.updated.slice(0, 16).replace("T", " "),
  ]);
  for (const l of s.table([head, ...rows], { columns: [{}, { align: "right" }, {}, { drop: 1 }] })) io.out(l);
  if (list.some((f) => f.params.some((x) => x.sensitive))) io.out(s.muted("* sensitive: no value is saved"));
  return Exit.ok;
}

const REPLAY_FLAGS: FlagSpec = {
  param: { type: "string", multiple: true },
  from: { type: "string" },
  headless: { type: "boolean" },
  ...JSON_FLAG,
};

/**
 * Runs a saved flow through turno-browser-mcp on the identity. A sensitive parameter on the
 * command line must be a `keychain:<item>` reference (a value would sit in the shell history and
 * the process list); on a terminal a missing one is asked for, hidden.
 */
export async function replay(c: Ctx, args: string[], io: Io): Promise<number> {
  const mod = c.api;
  const input = c.deps.input ?? terminalInput;
  const p = parseFlags(args, REPLAY_FLAGS, 2);
  const id = needIdentity(c, p.positionals[0], "replay", io);
  const name = p.positionals[1];
  if (!name)
    return fail(`usage: ${c.names.browser} replay <id> <flow> [--param name=value]... [--from <step>] [--headless]`);
  const flow = mod.readFlow(id, name, io.env);
  const params: Record<string, string> = {};
  const prompted: string[] = [];
  for (const pair of (p.values.param as string[] | undefined) ?? []) {
    const eq = pair.indexOf("=");
    if (eq <= 0) return fail(`--param takes name=value, not "${pair}"`);
    params[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  for (const param of flow.params) {
    const given = params[param.name];
    if (param.sensitive && given !== undefined && !given.startsWith("keychain:"))
      return fail(
        `"${param.name}" is sensitive: pass it as --param ${param.name}=keychain:<item> (${c.names.secretSet("<item>")}), not as a value on the command line`,
      );
    if (param.sensitive && given === undefined) {
      if (!input.isTty() || noInputReason(io.env))
        needsAnswer(`browser replay (parameter ${param.name})`, `--param ${param.name}=keychain:<item>`);
      params[param.name] = await input.hidden(`${param.name} (input hidden): `);
      prompted.push(param.name);
    }
  }
  const from = str(p, "from");
  if (from !== undefined && !/^\d+$/.test(from)) return fail(`--from takes a step number, not "${from}"`);
  const holder = mod.inUseBy(id, io.env);
  if (holder) return fail(holder);
  const result = await mod.replayFlow(id, name, {
    params,
    ...(prompted.length ? { prompted } : {}),
    ...(from ? { from: Number(from) } : {}),
    headless: bool(p, "headless"),
    env: io.env,
  });
  if (bool(p, "json")) {
    emit(io, p, REPLAY_JSON, { identity: `browser:${id}`, flow: name, ok: result.ok, report: result.text });
    return result.ok ? Exit.ok : Exit.failure;
  }
  const text = result.text.replace(/^### /gm, "");
  if (result.ok) io.out(text);
  else io.err(text);
  return result.ok ? Exit.ok : Exit.failure;
}

const TRACES_FLAGS: FlagSpec = { open: { type: "boolean" }, segment: { type: "string" }, ...JSON_FLAG };

export async function traces(c: Ctx, args: string[], io: Io): Promise<number> {
  const mod = c.api;
  const p = parseFlags(args, TRACES_FLAGS, 2);
  const id = needIdentity(c, p.positionals[0], "traces", io);
  const wanted = p.positionals[1];
  const list = mod.listRecordings(id, io.env);
  const s = style(io);
  if (bool(p, "open")) {
    const rec = wanted ? list.find((r) => r.name === wanted) : list.find((r) => r.traces.length);
    if (!rec)
      return fail(wanted ? `identity "${id}" has no recording "${wanted}"` : `identity "${id}" has no traces yet`);
    if (!rec.traces.length)
      return fail(`recording "${rec.name}" has no trace (screenshots are in ${tildify(rec.dir, io.env)})`);
    const segment = str(p, "segment");
    const n = segment === undefined ? rec.traces.length : Number(segment);
    const trace = rec.traces[n - 1];
    if (!trace || !Number.isInteger(n))
      return fail(`--segment takes 1 to ${rec.traces.length} for recording "${rec.name}"`);
    const { command, args: viewer } = mod.traceViewerCommand(trace.file);
    io.err(s.muted(`opening ${tildify(trace.file, io.env)} in the trace viewer; press Ctrl-C to stop it`));
    io.err(s.muted(`(the same by hand: ${[command, ...viewer].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ")})`));
    return (await mod.openTraceViewer(trace.file, io.env)) === 0 ? Exit.ok : Exit.failure;
  }
  const shown = wanted ? list.filter((r) => r.name === wanted) : list;
  if (wanted && !shown.length) return fail(`identity "${id}" has no recording "${wanted}"`);
  if (bool(p, "json")) {
    emit(
      io,
      p,
      TRACES_JSON,
      shown.map((r) => ({
        ...r,
        dir: tildify(r.dir, io.env),
        ended: r.ended ?? null,
        traces: r.traces.map((t) => ({ ...t, file: tildify(t.file, io.env) })),
      })),
    );
    return Exit.ok;
  }
  if (!shown.length) {
    io.out(
      `No recordings for "${id}". Turn them on with: ${c.names.browser} record ${id} --traces --screenshots (they start with the next Chrome)`,
    );
    return Exit.ok;
  }
  for (const [i, r] of shown.entries()) {
    if (i) io.out("");
    io.out(
      `${s.bold(r.name)}  ${s.muted(`${r.title}, ${r.started.slice(0, 19).replace("T", " ")}${r.ended ? "" : " (open or cut short)"}`)}`,
    );
    io.out(
      `  ${r.steps} step${r.steps === 1 ? "" : "s"}, ${r.screenshots} screenshot${r.screenshots === 1 ? "" : "s"}, ${r.traces.length} trace${r.traces.length === 1 ? "" : "s"}, ${size(r.bytes)}  ${s.muted(tildify(r.dir, io.env))}`,
    );
    for (const [n, t] of r.traces.entries())
      io.out(
        `  ${s.muted(`trace ${n + 1}:`)} ${tildify(t.file, io.env)} ${s.muted(`(steps ${t.from}-${t.to}, ${size(t.bytes)})`)}`,
      );
    for (const note of r.notes) io.out(s.note("info", note, 2));
  }
  io.out("");
  io.out(s.muted(`Open a trace: ${c.names.browser} traces ${id} [<recording>] --open [--segment <n>]`));
  return Exit.ok;
}

const RECORD_FLAGS: FlagSpec = {
  flows: { type: "boolean" },
  traces: { type: "boolean" },
  screenshots: { type: "boolean" },
  "max-size": { type: "string" },
  off: { type: "boolean" },
  ...DRY_RUN,
  ...JSON_FLAG,
};

/** `record <id>`: what the identity records, and turning it on or off. */
export function record(c: Ctx, args: string[], io: Io): number {
  const mod = c.api;
  const p = parseFlags(args, RECORD_FLAGS, 1);
  const id = needIdentity(c, p.positionals[0], "record", io);
  const current = mod.checkIdentitySettings(id, io.env).settings?.record;
  const on = (["flows", "traces", "screenshots"] as const).filter((k) => bool(p, k));
  const maxSize = str(p, "max-size");
  const off = bool(p, "off");
  if (off && (on.length || maxSize !== undefined))
    return fail("--off does not go with --flows, --traces, --screenshots or --max-size");
  const dryRun = bool(p, "dry-run");
  let next = current;
  if (off || on.length || maxSize !== undefined) {
    const patch = off
      ? { record: null }
      : {
          record: {
            ...current,
            ...Object.fromEntries(on.map((k) => [k, true])),
            ...(maxSize !== undefined ? { maxSize } : {}),
          },
        };
    if (!dryRun) {
      try {
        next = mod.writeIdentitySettings(id, patch, io.env).record;
      } catch (err) {
        if ((err as Error).name === "IdentityError")
          return fail(
            (err as Error).message.replace(/^identity "[^"]*": /, "").replace(/record\.maxSize/, "--max-size"),
          );
        throw err;
      }
    } else next = patch.record ?? undefined;
  }
  const flowsDir = mod.flowsDir(id, io.env);
  const recordingsDir = mod.recordingsDir(id, io.env);
  if (bool(p, "json")) {
    emit(io, p, RECORD_JSON, {
      id: `browser:${id}`,
      dryRun,
      record: next ?? null,
      flowsDir: tildify(flowsDir, io.env),
      recordingsDir: tildify(recordingsDir, io.env),
    });
    return Exit.ok;
  }
  const s = style(io);
  if (dryRun) io.out(`(dry run) would set record of "${id}" to ${JSON.stringify(next ?? null)}`);
  else if (off || on.length || maxSize !== undefined)
    io.out(`updated identity.json of "${id}"; the next Chrome start of browser-${id} uses it`);
  const rows: [string, string][] = [
    ["records", describeRecord(next) ?? s.muted("nothing (the agent can still record a flow with browser_record)")],
    ["flows", tildify(flowsDir, io.env)],
    ["recordings", tildify(recordingsDir, io.env)],
  ];
  const width = Math.max(...rows.map(([k]) => k.length));
  for (const [k, v] of rows) io.out(s.kv(k, v, width));
  return Exit.ok;
}
