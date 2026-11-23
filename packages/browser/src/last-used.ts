import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { replaceFileSync } from "turno-core/paths";
import { identityStateDir } from "./ids.js";

/**
 * When an identity last served a tool call, for `status`: `<state>/browser/identities/<id>/
 * last-used.json`, `{ "at": "<ISO time>" }`, mode 600. A server writes it when it serves a call,
 * at most once a minute (a busy session does not write a file per click), and a failed write is
 * ignored: it is a hint, never a reason for a call to fail. A server that starts and is never
 * called does not count as a use.
 */

const EVERY_MS = 60_000;

/** The last write per identity in this process, for the throttle. */
const written = new Map<string, number>();

function lastUsedPath(id: string, env: NodeJS.ProcessEnv): string {
  return join(identityStateDir(id, env), "last-used.json");
}

/** Record a use of the identity now, unless this process did so less than a minute ago. */
export function touchLastUsed(id: string, env: NodeJS.ProcessEnv = process.env, now: Date = new Date()): void {
  const key = `${identityStateDir(id, env)}`;
  const before = written.get(key);
  if (before !== undefined && now.getTime() - before < EVERY_MS) return;
  written.set(key, now.getTime());
  try {
    const file = lastUsedPath(id, env);
    mkdirSync(identityStateDir(id, env), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ at: now.toISOString() })}\n`, { mode: 0o600 });
    replaceFileSync(tmp, file);
  } catch {
    /* a hint only */
  }
}

/** When the identity last served a call, or undefined when it never did (or before this was kept). */
export function readLastUsed(id: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  try {
    const v = JSON.parse(readFileSync(lastUsedPath(id, env), "utf8")) as { at?: unknown };
    return typeof v.at === "string" && !Number.isNaN(Date.parse(v.at)) ? v.at : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Count the tool calls a stdio server gets: each chunk of its stdin that carries a `tools/call`
 * request touches the identity. It only listens, and only from the moment the MCP transport
 * starts reading: a `data` listener of its own before that would set stdin flowing, and the
 * transport would miss what arrived first.
 */
export function watchStdinCalls(
  id: string,
  env: NodeJS.ProcessEnv = process.env,
  stdin: NodeJS.ReadableStream = process.stdin,
): void {
  const onData = (chunk: Buffer | string) => {
    if (String(chunk).includes('"tools/call"')) touchLastUsed(id, env);
  };
  const hook = (event: string | symbol) => {
    if (event !== "data") return;
    stdin.off("newListener", hook);
    // Still before the transport's own listener is added, and before any data flows (a stream
    // starts flowing on the next tick).
    stdin.on("data", onData);
  };
  stdin.on("newListener", hook);
}
