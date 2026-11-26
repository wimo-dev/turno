import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { posix } from "node:path";
import type { Redactor } from "./redact.js";

/**
 * Notifications of the operating system, for the moments the agent waits on the person or is
 * done: a person step (`browser_request_human`), a page's passkey prompt, a captcha or a block
 * page nobody solves, and the end of a long run of calls. They use what the system already has,
 * with no dependency: `osascript` on macOS, `notify-send` on Linux (when it is installed), and a
 * toast through PowerShell on Windows.
 *
 * The text never comes from the command line of a shell: macOS gets it as `osascript`'s own
 * arguments, Linux as `notify-send`'s (after `--`, with its markup escaped), Windows through
 * environment variables the script reads, never pasted into the script. Every text goes through
 * the redactor first, so a vault value or a password shows as its placeholder, and is clipped.
 *
 * On by default; `notify: false` in identity.json or `TURNO_BROWSER_NOTIFY=off` turns it off.
 * The same notification is not shown twice within a minute.
 */

export interface Notice {
  title: string;
  body: string;
}

export interface NotifyCommand {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

/** Runs a command and forgets it. Tests pass their own. */
type NotifyRunner = (cmd: NotifyCommand) => void;

const TITLE_MAX = 80;
const BODY_MAX = 220;
/** The same notification again within this time is dropped. */
const REPEAT_MS = 60_000;

const clip = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
};

/** The environment value that turns notifications off. */
export function notifyOffByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.TURNO_BROWSER_NOTIFY?.trim().toLowerCase();
  return v === "0" || v === "off" || v === "false" || v === "no";
}

const WINDOWS_TOAST = [
  "$ErrorActionPreference = 'Stop'",
  "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null",
  "$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
  "$texts = $xml.GetElementsByTagName('text')",
  "$texts.Item(0).AppendChild($xml.CreateTextNode($env:TOAST_TITLE)) > $null",
  "$texts.Item(1).AppendChild($xml.CreateTextNode($env:TOAST_BODY)) > $null",
  "$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)",
  "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show($toast)",
].join("; ");

function onPath(name: string, env: NodeJS.ProcessEnv, exists: (p: string) => boolean): string | undefined {
  // Only Linux looks it up, so Linux paths (tests probe every system from one).
  for (const dir of (env.PATH ?? "").split(posix.delimiter)) {
    if (!dir) continue;
    const path = posix.join(dir, name);
    if (exists(path)) return path;
  }
  return undefined;
}

/** The command that shows a notification on this system, or undefined when there is none. */
export function notifyCommand(
  notice: Notice,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): NotifyCommand | undefined {
  const { title, body } = notice;
  if (platform === "darwin")
    return {
      command: "/usr/bin/osascript",
      args: [
        "-e",
        "on run argv",
        "-e",
        "display notification (item 2 of argv) with title (item 1 of argv)",
        "-e",
        "end run",
        title,
        body,
      ],
    };
  if (platform === "win32") {
    const root = env.SystemRoot ?? "C:\\Windows";
    return {
      command: `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
      args: ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", WINDOWS_TOAST],
      env: { ...env, TOAST_TITLE: title, TOAST_BODY: body },
    };
  }
  const send = onPath("notify-send", env, exists);
  if (!send) return undefined;
  // notify-send reads the body as markup.
  const plain = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return { command: send, args: ["--app-name=turno", "--", title, plain(body)] };
}

const spawnDetached: NotifyRunner = (cmd) => {
  try {
    const child = spawn(cmd.command, cmd.args, {
      stdio: "ignore",
      detached: process.platform !== "win32",
      windowsHide: true,
      ...(cmd.env ? { env: cmd.env } : {}),
    });
    child.on("error", () => {});
    const timer = setTimeout(() => child.kill(), 10_000);
    timer.unref();
    child.on("exit", () => clearTimeout(timer));
    child.unref();
  } catch {
    /* no notification is not worth an error */
  }
};

export interface NotifierOptions {
  enabled: boolean;
  redactor: Redactor;
  run?: NotifyRunner;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Whether a file exists (where `notify-send` is); tests pass their own. */
  exists?: (path: string) => boolean;
  now?: () => number;
}

/** Shows notifications for one server, redacted, clipped and without repeats. */
export class Notifier {
  private readonly sent = new Map<string, number>();
  constructor(private readonly o: NotifierOptions) {}

  get enabled(): boolean {
    return this.o.enabled;
  }

  /** Shows the notice; returns the command it ran (for tests), undefined when it showed none. */
  send(notice: Notice): NotifyCommand | undefined {
    if (!this.o.enabled) return undefined;
    const now = (this.o.now ?? Date.now)();
    const safe = {
      title: clip(this.o.redactor.text(notice.title), TITLE_MAX),
      body: clip(this.o.redactor.text(notice.body), BODY_MAX),
    };
    const key = `${safe.title}\n${safe.body}`;
    const last = this.sent.get(key);
    if (last !== undefined && now - last < REPEAT_MS) return undefined;
    this.sent.set(key, now);
    for (const [k, at] of this.sent) if (now - at >= REPEAT_MS) this.sent.delete(k);
    const cmd = notifyCommand(safe, this.o.platform, this.o.env, this.o.exists);
    if (cmd) (this.o.run ?? spawnDetached)(cmd);
    return cmd;
  }
}

/** A long run of calls: notified when the agent stops using the browser after it. */
const LONG_RUN_MS = 60_000;
/** How long without a call ends a run. */
const RUN_IDLE_MS = 20_000;

/**
 * Tells the person when the agent is done with the browser after a long run: at least
 * `LONG_RUN_MS` of calls, then `RUN_IDLE_MS` without one. A short task is not worth a
 * notification; the person was likely watching it.
 */
export class RunWatch {
  private start: number | undefined;
  private last = 0;
  private steps = 0;
  private timer: NodeJS.Timeout | undefined;
  constructor(
    private readonly done: (steps: number, ms: number) => void,
    private readonly o: { longMs?: number; idleMs?: number; now?: () => number } = {},
  ) {}

  /** A call ended. */
  call(): void {
    const now = (this.o.now ?? Date.now)();
    this.start ??= now;
    this.last = now;
    this.steps++;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.end(), this.o.idleMs ?? RUN_IDLE_MS);
    this.timer.unref();
  }

  /** The person is on it (a pause, a person step): the run so far is not "done". */
  reset(): void {
    clearTimeout(this.timer);
    this.start = undefined;
    this.steps = 0;
  }

  private end(): void {
    const { start, steps } = this;
    this.reset();
    if (start === undefined) return;
    const ms = this.last - start;
    if (ms >= (this.o.longMs ?? LONG_RUN_MS)) this.done(steps, ms);
  }

  dispose(): void {
    this.reset();
  }
}
