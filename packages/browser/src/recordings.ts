import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { inflateRawSync } from "node:zlib";
import type { BrowserContext, Page } from "patchright-core";
import type { IdentityRef } from "./engine.js";
import { identityStateDir } from "./ids.js";
import type { Redactor, VaultGuard } from "./redact.js";
import type { RecordSettings } from "./settings.js";
import { parseSize } from "./units.js";

/**
 * Recordings of an identity's browser sessions, opt-in in identity.json (`record.traces`,
 * `record.screenshots`): a Playwright trace (DOM snapshots, network, a screencast) and a
 * screenshot after each action, in one folder per browser session under
 * `<state>/browser/identities/<id>/recordings/`. The folders together stay under
 * `record.maxSize` (200MB by default): the oldest go first.
 *
 * A trace keeps what the page held, so a vault sign-in is never in one:
 *
 * - Before `browser_login` fills a form (or a value goes into a password field, or a replay
 *   types a sensitive parameter), the trace is stopped and saved. Stopping, not a new chunk:
 *   Playwright keeps recording network entries between chunks and copies them into the next
 *   one, so a sign-in request would land in the next file.
 * - It starts again at the first call after every page that holds those values has navigated
 *   away (the vault guard), so neither the filled form nor the request that sends it is traced.
 * - Each saved trace is read back and searched for the passwords, one-time codes and sensitive
 *   values this server knows (the values of the pages' password and one-time code fields are
 *   read just before), in the encodings the redactor knows; a trace that holds one, or that
 *   cannot be read while such values exist, is deleted.
 * - No screenshot is taken of a page while it holds those values. There is no video: a video
 *   cannot leave the sign-in out.
 *
 * Playwright writes a trace's raw files to the launch's `tracesDir` first; the host points it
 * at a folder of this identity, emptied after every trace, instead of the workspace.
 */

const require = createRequire(import.meta.url);

/** Default size cap of an identity's recordings. */
const DEFAULT_RECORD_BYTES = 200 * 1024 ** 2;

/** Values a saved trace must not hold (labels the redactor gives them). */
const SECRET_LABEL = /password|one-time code|sensitive/;

const INDEX = "index.json";
const TRACES_TMP = ".traces-tmp";

export function recordingsDir(id: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(identityStateDir(id, env), "recordings");
}

/** Where Playwright writes a trace's raw files while it records (the launch's `tracesDir`). */
export function tracesTmpDir(id: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(recordingsDir(id, env), TRACES_TMP);
}

interface StepEntry {
  n: number;
  at: string;
  tool: string;
  element?: string;
  url?: string;
  ok: boolean;
  screenshot?: string;
  note?: string;
}

interface TraceEntry {
  file: string;
  /** First and last step it covers (0 when it covers none). */
  from: number;
  to: number;
  bytes?: number;
  /** Why the file was deleted. */
  discarded?: string;
}

interface RecordingIndex {
  version: 1;
  identity: string;
  title: string;
  started: string;
  ended?: string;
  steps: StepEntry[];
  traces: TraceEntry[];
  notes: string[];
}

export interface RecordingSummary {
  name: string;
  dir: string;
  title: string;
  started: string;
  ended?: string;
  steps: number;
  screenshots: number;
  traces: { file: string; from: number; to: number; bytes: number }[];
  discarded: number;
  bytes: number;
  notes: string[];
}

function dirSize(path: string): number {
  let total = 0;
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = join(path, e.name);
    if (e.isDirectory()) total += dirSize(p);
    else
      try {
        total += statSync(p).size;
      } catch {
        /* gone meanwhile */
      }
  }
  return total;
}

function readIndex(dir: string): RecordingIndex | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(dir, INDEX), "utf8")) as RecordingIndex;
    return raw && raw.version === 1 && Array.isArray(raw.steps) && Array.isArray(raw.traces) ? raw : undefined;
  } catch {
    return undefined;
  }
}

/** The recording folders of an identity, oldest first (their names sort by time). */
function recordingFolders(id: string, env: NodeJS.ProcessEnv): string[] {
  const root = recordingsDir(id, env);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();
}

/** An identity's recordings, newest first. */
export function listRecordings(id: string, env: NodeJS.ProcessEnv = process.env): RecordingSummary[] {
  const root = recordingsDir(id, env);
  return recordingFolders(id, env)
    .reverse()
    .flatMap((name) => {
      const dir = join(root, name);
      const index = readIndex(dir);
      if (!index) return [];
      const traces = index.traces
        .filter((t) => !t.discarded && existsSync(join(dir, t.file)))
        .map((t) => ({ file: join(dir, t.file), from: t.from, to: t.to, bytes: statSync(join(dir, t.file)).size }));
      return [
        {
          name,
          dir,
          title: index.title,
          started: index.started,
          ...(index.ended ? { ended: index.ended } : {}),
          steps: index.steps.length,
          screenshots: index.steps.filter((s) => s.screenshot).length,
          traces,
          discarded: index.traces.filter((t) => t.discarded).length,
          bytes: dirSize(dir),
          notes: index.notes,
        },
      ];
    });
}

/**
 * The command that opens a trace in the trace viewer patchright-core ships (its own
 * `show-trace`, served on 127.0.0.1 and opened in the default browser). Never `npx`, which
 * would download whatever package has that name.
 */
export function traceViewerCommand(file: string): { command: string; args: string[] } {
  const cli = join(dirname(require.resolve("patchright-core/package.json")), "cli.js");
  return { command: process.execPath, args: [cli, "show-trace", "--host", "127.0.0.1", "--port", "0", file] };
}

/** Runs the trace viewer until the person stops it; resolves with its exit code. */
export function openTraceViewer(file: string, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  if (!existsSync(file)) return Promise.reject(new Error(`no trace at ${file}`));
  const { command, args } = traceViewerCommand(file);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 0));
  });
}

/**
 * The text of every entry of a zip, images left out. Handles stored and deflated entries (what
 * Playwright writes); throws on anything else, so a caller can treat the file as unreadable.
 */
export function zipTexts(buf: Buffer): { name: string; text: string }[] {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip file");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out: { name: string; text: string }[] = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("bad zip directory");
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (size === 0xffffffff || local === 0xffffffff) throw new Error("zip64 is not read");
    if (/\.(png|jpe?g|webp)$/i.test(name)) continue;
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error("bad zip entry");
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    if (method === 0) out.push({ name, text: data.toString("utf8") });
    else if (method === 8) out.push({ name, text: inflateRawSync(data).toString("utf8") });
    else throw new Error(`zip method ${method} is not read`);
  }
  return out;
}

/** The secret labels a trace file holds; `["unreadable"]` when it cannot be searched. */
export function traceLeaks(file: string, redactor: Redactor): string[] {
  let texts: { text: string }[];
  try {
    texts = zipTexts(readFileSync(file));
  } catch {
    return ["unreadable"];
  }
  const found = new Set<string>();
  for (const { text } of texts) for (const l of redactor.labelsIn(text, (x) => SECRET_LABEL.test(x))) found.add(l);
  return [...found];
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function plainUrl(url: string): string | undefined {
  try {
    const u = new URL(url);
    return u.protocol === "about:" ? undefined : `${u.origin}${u.pathname}`;
  } catch {
    return undefined;
  }
}

export interface RecordingOptions {
  identity: IdentityRef;
  settings: RecordSettings;
  context: BrowserContext;
  redactor: Redactor;
  guard: VaultGuard;
  /** The session title (the client's name), shown by `turno browser traces`. */
  title: string;
  /** The browser's idle limit: the trace is saved shortly before it, while Chrome still runs. */
  idleMs?: number;
  /** Why traces cannot be recorded in this session (another trace owner); screenshots still are. */
  noTraces?: string;
  /**
   * Runs before a trace is saved: the host reads the sensitive fields of every page, so a value
   * the person typed since the last tool call joins the redactor and the search below finds it.
   */
  beforeSave?: () => Promise<void>;
  now?: () => Date;
}

/** The recording of one browser session (one launch). */
export class Recording {
  readonly dir: string;
  private readonly index: RecordingIndex;
  private trace: "off" | "on" | "paused" = "off";
  private segment = 0;
  private segmentFrom = 1;
  private flushing: Promise<void> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private readonly cap: number;
  private bytes = 0;
  private capNoted = false;
  private closed = false;

  private constructor(private readonly o: RecordingOptions) {
    const now = (o.now ?? (() => new Date()))();
    const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").replace(".", "-").slice(0, 19);
    let dir = join(recordingsDir(o.identity.id, o.identity.env), stamp);
    for (let n = 2; existsSync(dir); n++) dir = join(recordingsDir(o.identity.id, o.identity.env), `${stamp}-${n}`);
    this.dir = dir;
    this.cap = (o.settings.maxSize ? parseSize(o.settings.maxSize) : undefined) ?? DEFAULT_RECORD_BYTES;
    this.index = {
      version: 1,
      identity: o.identity.id,
      title: o.title,
      started: now.toISOString(),
      steps: [],
      traces: [],
      notes: o.noTraces && o.settings.traces ? [`no trace: ${o.noTraces}`] : [],
    };
  }

  /** Starts a recording for a launched browser; undefined when identity.json asks for none. */
  static async open(o: RecordingOptions): Promise<Recording | undefined> {
    if (!o.settings.traces && !o.settings.screenshots) return undefined;
    const r = new Recording(o);
    mkdirSync(r.dir, { recursive: true, mode: 0o700 });
    rmSync(tracesTmpDir(o.identity.id, o.identity.env), { recursive: true, force: true });
    r.rotate(r.cap / 2);
    r.write();
    if (o.settings.traces && !o.noTraces) await r.startTrace();
    return r;
  }

  private get others(): number {
    const root = recordingsDir(this.o.identity.id, this.o.identity.env);
    return recordingFolders(this.o.identity.id, this.o.identity.env)
      .map((name) => join(root, name))
      .filter((d) => d !== this.dir)
      .reduce((sum, d) => sum + dirSize(d), 0);
  }

  /** Deletes the oldest other recordings until they take at most `limit` bytes. */
  private rotate(limit: number): void {
    const root = recordingsDir(this.o.identity.id, this.o.identity.env);
    const folders = recordingFolders(this.o.identity.id, this.o.identity.env)
      .map((name) => join(root, name))
      .filter((d) => d !== this.dir);
    let total = folders.reduce((sum, d) => sum + dirSize(d), 0);
    for (const d of folders) {
      if (total <= limit) break;
      total -= dirSize(d);
      rmSync(d, { recursive: true, force: true });
    }
  }

  /** Room for `size` more bytes, deleting older recordings first; false when the cap is reached. */
  private room(size: number): boolean {
    if (this.bytes + size + this.others <= this.cap) return true;
    this.rotate(Math.max(0, this.cap - this.bytes - size));
    if (this.bytes + size + this.others <= this.cap) return true;
    if (!this.capNoted) {
      this.capNoted = true;
      this.index.notes.push(`stopped at the size cap (record.maxSize ${this.o.settings.maxSize ?? "200MB"})`);
    }
    return false;
  }

  private write(): void {
    try {
      const file = join(this.dir, INDEX);
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(this.index, null, 2)}\n`, { mode: 0o600 });
      renameSync(tmp, file);
    } catch {
      /* best effort: a full disk must not break a tool call */
    }
  }

  private async startTrace(): Promise<void> {
    this.segment++;
    try {
      await this.o.context.tracing.start({
        name: `segment-${this.segment}`,
        title: this.o.title,
        screenshots: true,
        snapshots: true,
      });
      this.trace = "on";
      this.segmentFrom = this.index.steps.length + 1;
    } catch (error) {
      this.trace = "off";
      this.index.notes.push(`no trace: ${String((error as Error).message ?? error).split("\n")[0]}`);
      this.write();
    }
  }

  /** Stops the trace and keeps the file, unless it holds a secret or passes the cap. */
  private async stopTrace(why: string): Promise<void> {
    if (this.trace !== "on") return;
    this.trace = "paused";
    const name = `trace-${this.segment}.zip`;
    const file = join(this.dir, name);
    const entry: TraceEntry = { file: name, from: this.segmentFrom, to: this.index.steps.length };
    if (entry.to < entry.from) entry.from = entry.to = 0;
    await this.o.beforeSave?.().catch(() => {});
    try {
      await this.o.context.tracing.stop({ path: file });
    } catch (error) {
      entry.discarded = `not saved (${why}): ${String((error as Error).message ?? error).split("\n")[0]}`;
    } finally {
      rmSync(tracesTmpDir(this.o.identity.id, this.o.identity.env), { recursive: true, force: true });
    }
    if (!entry.discarded && existsSync(file)) {
      const leaks = this.o.redactor.active ? traceLeaks(file, this.o.redactor) : [];
      const size = statSync(file).size;
      if (leaks.length) {
        rmSync(file, { force: true });
        entry.discarded =
          leaks[0] === "unreadable"
            ? "deleted: it could not be searched for vault values"
            : "deleted: it held a vault or sensitive value";
      } else if (!this.room(size)) {
        rmSync(file, { force: true });
        entry.discarded = "deleted: over the size cap";
        this.trace = "off";
      } else {
        this.bytes += size;
        entry.bytes = size;
      }
    }
    this.index.traces.push(entry);
    this.write();
  }

  /** Before a tool call: waits for a save in progress and starts the trace again when it may. */
  async beforeCall(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.flushing;
    if (this.closed || this.trace !== "paused" || this.capNoted) return;
    const held = this.o.context.pages().some((p) => this.o.guard.holds(p));
    if (!held) await this.startTrace();
  }

  /** After a tool call: saves the trace shortly before the idle limit would close Chrome. */
  callEnded(): void {
    if (this.trace !== "on" || !this.o.idleMs) return;
    const ms = this.o.idleMs > 10_000 ? this.o.idleMs - 5_000 : Math.floor(this.o.idleMs / 2);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flushing = this.stopTrace("before the idle limit").finally(() => {
        this.flushing = undefined;
      });
    }, ms);
    this.timer.unref();
  }

  /**
   * Before a secret goes into `page` (a vault fill, a password typed, a sensitive parameter):
   * saves the trace and holds `page` in the vault guard, so neither the trace nor a
   * screenshot starts again until it navigates.
   */
  async pauseForSecret(page: Page | undefined): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.flushing;
    if (page) this.o.guard.mark(page);
    await this.stopTrace("before a secret was filled");
  }

  /**
   * The user takes over the browser (the live view's pause): the trace is saved, so what the
   * user does is not in it, and starts again at the agent's next call.
   */
  async pauseForUser(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.flushing;
    await this.stopTrace("when the user took over");
  }

  /** After an action: one line in the index and, when asked, a screenshot. */
  async afterStep(step: {
    tool: string;
    element?: unknown;
    ok: boolean;
    page?: Page;
    screenshot: boolean;
  }): Promise<void> {
    if (this.closed) return;
    const n = this.index.steps.length + 1;
    const entry: StepEntry = { n, at: new Date().toISOString(), tool: step.tool, ok: step.ok };
    if (typeof step.element === "string" && step.element) entry.element = clip(this.o.redactor.text(step.element), 120);
    const url = step.page ? plainUrl(step.page.url()) : undefined;
    if (url) entry.url = this.o.redactor.text(url);
    if (this.o.settings.screenshots && step.screenshot && step.page) {
      if (this.o.guard.holds(step.page)) entry.note = "no screenshot: the page holds vault or sensitive values";
      else {
        const shot = await step.page.screenshot({ type: "jpeg", quality: 60, timeout: 5_000 }).catch(() => undefined);
        if (shot && this.room(shot.length)) {
          const rel = join("steps", `${String(n).padStart(3, "0")}-${step.tool}.jpg`);
          try {
            mkdirSync(join(this.dir, "steps"), { recursive: true, mode: 0o700 });
            writeFileSync(join(this.dir, rel), shot, { mode: 0o600 });
            this.bytes += shot.length;
            entry.screenshot = rel;
          } catch {
            /* best effort */
          }
        }
      }
    }
    this.index.steps.push(entry);
    this.write();
  }

  /** Before turno closes the browser: saves the trace. */
  async close(): Promise<void> {
    if (this.closed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.flushing;
    await this.stopTrace("when the browser closed");
    this.closed = true;
    this.index.ended = new Date().toISOString();
    this.write();
  }

  /** The browser went away on its own (a crash, a kill): the trace in progress is lost. */
  abandon(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.trace === "on") this.index.notes.push("the browser closed before the last trace was saved");
    this.trace = "off";
    this.index.ended = new Date().toISOString();
    this.write();
    rmSync(tracesTmpDir(this.o.identity.id, this.o.identity.env), { recursive: true, force: true });
  }
}
