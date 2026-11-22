import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { browserPaths as paths, replaceFileSync } from "turno-core/paths";
import { assertIdentityId } from "./ids.js";

/**
 * Saved flows: the browser actions a session made on an identity, stored so that
 * `browser_replay` (and `turno browser replay`) can run them again without the model working
 * the page out a second time. One JSON file per flow, under `<data>/browser/flows/<id>/`, next
 * to the identity's other files and never inside its Chrome profile.
 *
 * What a flow file holds, and what it never holds:
 *
 * - Each step names a browser tool and its arguments. An element is kept as several
 *   locators (Playwright's own pick, role and accessible name, visible text, a CSS path), tried
 *   in that order on replay, plus the snapshot ref it had (for reading only: refs change with
 *   every snapshot, so replay never uses one).
 * - Text typed into a field is a parameter (`{ "$param": "email" }`). A non-sensitive one keeps
 *   what was typed as its default; a sensitive one (a password field, a one-time code, a card
 *   number, a value the agent marked) keeps no value at all, so replay needs it again.
 * - A vault sign-in is a `browser_login` step with the site's name only: the values stay in
 *   the secret store and are read again at replay.
 */

/** The flow file format this package writes and reads. */
export const FLOW_FORMAT_VERSION = 1;

/** Most steps one flow holds. */
export const MAX_FLOW_STEPS = 200;

const FLOW_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** The prefix of the flows an identity records by itself (`record.flows`). */
export const AUTO_PREFIX = "auto-";

export class FlowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlowError";
  }
}

/** One way to find an element again, as a Playwright selector. */
export interface FlowLocator {
  /** `generated` (Playwright's own), `role` (role and accessible name), `text`, `css`. */
  kind: "generated" | "role" | "text" | "css";
  selector: string;
}

/** An element a step acts on. */
export interface FlowTarget {
  /** What the element is, for people and for the failure report ("Sign in button"). */
  description?: string;
  /** Tried in order on replay; the first that matches exactly one visible element wins. */
  locators: FlowLocator[];
  /** The snapshot ref the element had when it was recorded; never used to replay. */
  ref?: string;
}

/** A parameter slot inside a step's arguments. */
export interface ParamRef {
  $param: string;
}

export interface FlowParam {
  name: string;
  /** True: the value is never stored, and replay needs it (`keychain:<item>` keeps it from the model). */
  sensitive: boolean;
  /** What was typed when it was recorded; never present for a sensitive parameter. */
  default?: string;
  /** The field it was typed into. */
  description?: string;
}

export interface FlowStep {
  tool: string;
  /** The tool's arguments without its element targets; parameter slots are `ParamRef`s. */
  args: Record<string, unknown>;
  /** The element of each target argument, by its path in `args` (`target`, `fields.0.target`). */
  targets?: Record<string, FlowTarget>;
  /** The URL of the page when the step ran (no query or fragment). */
  url?: string;
}

export interface Flow {
  version: number;
  name: string;
  description?: string;
  identity: string;
  created: string;
  updated: string;
  params: FlowParam[];
  steps: FlowStep[];
}

export interface FlowSummary {
  name: string;
  description?: string;
  steps: number;
  params: { name: string; sensitive: boolean; hasDefault: boolean }[];
  /** First page the flow visits, when it navigates. */
  start?: string;
  auto: boolean;
  updated: string;
  file: string;
}

function isValidFlowName(name: string): boolean {
  return FLOW_NAME.test(name);
}

export function assertFlowName(name: string): void {
  if (!isValidFlowName(name))
    throw new FlowError(
      `invalid flow name "${name}": use up to 64 lowercase letters, digits, "-" and "_", starting with a letter or digit`,
    );
}

/** Where an identity's flows live: `<data>/browser/flows/<id>`. */
export function flowsDir(id: string, env: NodeJS.ProcessEnv = process.env): string {
  assertIdentityId(id);
  return join(paths(env).browserDir, "flows", id);
}

export function flowPath(id: string, name: string, env: NodeJS.ProcessEnv = process.env): string {
  assertFlowName(name);
  return join(flowsDir(id, env), `${name}.json`);
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function isParamRef(v: unknown): v is ParamRef {
  return isObject(v) && typeof v.$param === "string" && Object.keys(v).length === 1;
}

/** Everything wrong with a parsed flow file; empty when it is valid. */
export function flowProblems(raw: unknown): string[] {
  if (!isObject(raw)) return ["must be a JSON object"];
  const out: string[] = [];
  if (typeof raw.version !== "number" || !Number.isInteger(raw.version) || raw.version < 1)
    out.push("version must be a positive integer");
  else if (raw.version > FLOW_FORMAT_VERSION)
    return [`is format ${raw.version}, from a newer turno-browser (this one reads ${FLOW_FORMAT_VERSION}); update it`];
  if (typeof raw.name !== "string" || !isValidFlowName(raw.name)) out.push("name must be a flow name");
  if (typeof raw.identity !== "string") out.push("identity must be a string");
  if (raw.description !== undefined && typeof raw.description !== "string") out.push("description must be a string");
  const names = new Set<string>();
  if (!Array.isArray(raw.params)) out.push("params must be a list");
  else
    raw.params.forEach((p, i) => {
      if (!isObject(p) || typeof p.name !== "string" || typeof p.sensitive !== "boolean")
        out.push(`params[${i}] needs a name and sensitive`);
      else {
        names.add(p.name);
        if (p.sensitive && p.default !== undefined) out.push(`params[${i}] is sensitive and must not keep a default`);
        if (p.default !== undefined && typeof p.default !== "string") out.push(`params[${i}].default must be a string`);
      }
    });
  if (!Array.isArray(raw.steps)) out.push("steps must be a list");
  else {
    if (raw.steps.length > MAX_FLOW_STEPS) out.push(`steps holds more than ${MAX_FLOW_STEPS} steps`);
    raw.steps.forEach((s, i) => {
      if (!isObject(s) || typeof s.tool !== "string" || !isObject(s.args)) {
        out.push(`steps[${i}] needs a tool and args`);
        return;
      }
      for (const ref of paramRefs(s.args))
        if (!names.has(ref)) out.push(`steps[${i}] uses parameter "${ref}", which params does not list`);
      if (s.targets !== undefined) {
        if (!isObject(s.targets)) out.push(`steps[${i}].targets must be an object`);
        else
          for (const [path, t] of Object.entries(s.targets)) {
            if (
              !isObject(t) ||
              !Array.isArray(t.locators) ||
              t.locators.some((l) => !isObject(l) || typeof l.selector !== "string")
            )
              out.push(`steps[${i}].targets.${path} needs a list of locators`);
          }
      }
    });
  }
  return out;
}

/** The parameter names a value uses, at any depth. */
export function paramRefs(value: unknown): string[] {
  if (isParamRef(value)) return [value.$param];
  if (Array.isArray(value)) return value.flatMap(paramRefs);
  if (isObject(value)) return Object.values(value).flatMap(paramRefs);
  return [];
}

/** A copy of `value` with every parameter slot replaced by its value. */
export function fillParams(value: unknown, values: Record<string, string>): unknown {
  if (isParamRef(value)) return values[value.$param];
  if (Array.isArray(value)) return value.map((v) => fillParams(v, values));
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillParams(v, values)]));
  return value;
}

/** Reads `a.b.0.c` of an object. */
export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split(".")) {
    if (Array.isArray(cur)) cur = cur[Number(key)];
    else if (isObject(cur)) cur = cur[key];
    else return undefined;
  }
  return cur;
}

/** Sets `a.b.0.c` of an object that already has every level but the last. */
export function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split(".");
  let cur: unknown = obj;
  for (const key of keys.slice(0, -1))
    cur = Array.isArray(cur) ? cur[Number(key)] : (cur as Record<string, unknown>)[key];
  const last = keys[keys.length - 1]!;
  if (Array.isArray(cur)) cur[Number(last)] = value;
  else if (isObject(cur)) cur[last] = value;
}

/**
 * The parameter values a replay runs with: the given ones, then the defaults. `missing` lists
 * the parameters with neither (every sensitive one not given), `unknown` the given names the
 * flow does not have.
 */
export function resolveParams(
  flow: Pick<Flow, "params">,
  given: Record<string, string> = {},
): { values: Record<string, string>; missing: FlowParam[]; unknown: string[] } {
  const values: Record<string, string> = {};
  const missing: FlowParam[] = [];
  for (const p of flow.params) {
    const v = given[p.name] ?? p.default;
    if (v === undefined) missing.push(p);
    else values[p.name] = v;
  }
  const known = new Set(flow.params.map((p) => p.name));
  return { values, missing, unknown: Object.keys(given).filter((k) => !known.has(k)) };
}

/** A step in a few words: `browser_click "Sign in" button`, `browser_navigate https://...`. */
export function describeStep(step: FlowStep): string {
  const t = step.targets?.target ?? step.targets?.startTarget;
  const a = step.args;
  if (step.tool === "browser_login") return `browser_login site "${String(a.site)}"`;
  if (step.tool === "browser_replay") return `browser_replay flow "${String(a.flow)}"`;
  if (step.tool === "browser_fill_form") {
    const fields = Array.isArray(a.fields) ? (a.fields as { name?: string }[]).map((f) => f.name ?? "?") : [];
    return `browser_fill_form ${fields.join(", ")}`;
  }
  const what = t ? (t.description ?? t.locators[0]?.selector) : (a.url ?? a.key ?? a.action ?? a.text ?? a.time);
  const typed = isParamRef(a.text) ? ` with {${a.text.$param}}` : "";
  return `${step.tool}${what === undefined ? "" : ` ${clip(String(what), 80)}`}${typed}`;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

/** Writes a flow (mode 600, through a rename). Validates first. */
export function writeFlow(id: string, flow: Flow, env: NodeJS.ProcessEnv = process.env): string {
  const problems = flowProblems(flow);
  if (problems.length) throw new FlowError(`flow "${flow.name}" ${problems.join("; ")}`);
  const path = flowPath(id, flow.name, env);
  mkdirSync(flowsDir(id, env), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(flow, null, 2)}\n`, { mode: 0o600 });
  replaceFileSync(tmp, path);
  return path;
}

/** A saved flow; throws a FlowError when there is none or it cannot be used. */
export function readFlow(id: string, name: string, env: NodeJS.ProcessEnv = process.env): Flow {
  const path = flowPath(id, name, env);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      const known = listFlows(id, env).map((f) => f.name);
      throw new FlowError(
        `identity "${id}" has no flow "${name}"${known.length ? ` (saved: ${known.join(", ")})` : " (it has no saved flows)"}`,
      );
    }
    throw new FlowError(`cannot read flow "${name}": ${(err as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new FlowError(`flow "${name}" (${path}) is not valid JSON`);
  }
  const problems = flowProblems(raw);
  if (problems.length) throw new FlowError(`flow "${name}" (${path}) ${problems.join("; ")}`);
  return raw as Flow;
}

/** The identity's saved flows, newest first. Files that cannot be read are left out. */
export function listFlows(id: string, env: NodeJS.ProcessEnv = process.env): FlowSummary[] {
  const dir = flowsDir(id, env);
  if (!existsSync(dir)) return [];
  const out: FlowSummary[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    const name = file.slice(0, -5);
    if (!isValidFlowName(name)) continue;
    let flow: Flow;
    try {
      flow = JSON.parse(readFileSync(join(dir, file), "utf8")) as Flow;
      if (flowProblems(flow).length) continue;
    } catch {
      continue;
    }
    const nav = flow.steps.find((s) => s.tool === "browser_navigate");
    out.push({
      name,
      ...(flow.description ? { description: flow.description } : {}),
      steps: flow.steps.length,
      params: flow.params.map((p) => ({ name: p.name, sensitive: p.sensitive, hasDefault: p.default !== undefined })),
      ...(nav && typeof nav.args.url === "string" ? { start: nav.args.url } : {}),
      auto: name.startsWith(AUTO_PREFIX),
      updated: flow.updated,
      file: join(dir, file),
    });
  }
  return out.sort((a, b) => b.updated.localeCompare(a.updated) || a.name.localeCompare(b.name));
}

/** Deletes a flow; false when there was none. */
export function removeFlow(id: string, name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const path = flowPath(id, name, env);
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}

/** Keeps the newest `keep` flows the identity recorded by itself; returns how many went. */
export function rotateAutoFlows(id: string, keep: number, env: NodeJS.ProcessEnv = process.env): number {
  const dir = flowsDir(id, env);
  if (!existsSync(dir)) return 0;
  const auto = readdirSync(dir)
    .filter((f) => f.startsWith(AUTO_PREFIX) && f.endsWith(".json"))
    .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t || b.f.localeCompare(a.f));
  for (const { f } of auto.slice(keep)) rmSync(join(dir, f), { force: true });
  return Math.max(0, auto.length - keep);
}

/** Removes every flow of an identity (when the identity goes). */
export function removeFlows(id: string, env: NodeJS.ProcessEnv = process.env): void {
  rmSync(flowsDir(id, env), { recursive: true, force: true });
}
