import { readFileSync, rmSync } from "node:fs";
import { request } from "node:http";
import { pidAlive } from "turno-core/process";
import { assertIdentityId } from "./ids.js";
import { type LiveFile, liveFilePath } from "./live.js";
import type { LiveStatus } from "./live-server.js";
import { names } from "./names.js";

/**
 * What `turno browser live|pause|resume` use: the running server's live view, reached over its
 * control socket (`live-server.ts`). Nothing here holds a token; a link for the view comes
 * from the server with a code that works once.
 */

export class LiveError extends Error {
  override name = "LiveError";
}

/** The live.json of a running server, or undefined (a stale one is removed). */
export function readLiveFile(id: string, env: NodeJS.ProcessEnv = process.env): LiveFile | undefined {
  assertIdentityId(id);
  const file = liveFilePath(id, env);
  let data: Partial<LiveFile>;
  try {
    data = JSON.parse(readFileSync(file, "utf8")) as Partial<LiveFile>;
  } catch {
    return undefined;
  }
  if (data.version !== 1 || typeof data.pid !== "number" || typeof data.socket !== "string") return undefined;
  if (!pidAlive(data.pid)) {
    rmSync(file, { force: true });
    return undefined;
  }
  return data as LiveFile;
}

function call(
  socket: string,
  method: "GET" | "POST",
  path: string,
  payload: Record<string, unknown> = {},
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { socketPath: socket, method, path, headers: { host: "turno-live" }, timeout: 10_000 },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          let body: unknown;
          try {
            body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            body = undefined;
          }
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("the live view server did not answer in 10s")));
    req.on("error", reject);
    if (method === "POST") req.end(JSON.stringify(payload));
    else req.end();
  });
}

async function ask(
  id: string,
  method: "GET" | "POST",
  path: string,
  env: NodeJS.ProcessEnv,
  payload?: Record<string, unknown>,
): Promise<unknown> {
  const live = readLiveFile(id, env);
  if (!live)
    throw new LiveError(
      `no turno-browser-mcp serves "${id}" with the live view right now. It starts with the server (an agent session starts one), unless ${names().browser} set ${id} --live false turned it off.`,
    );
  let out: { status: number; body: unknown };
  try {
    out = await call(live.socket, method, path, payload);
  } catch (error) {
    throw new LiveError(`cannot reach the live view of "${id}" (pid ${live.pid}): ${(error as Error).message}`);
  }
  const error = (out.body as { error?: unknown } | undefined)?.error;
  if (out.status !== 200)
    throw new LiveError(typeof error === "string" ? error : `the live view answered ${out.status}`);
  return out.body;
}

/** The live view's state, or undefined when no server serves it. */
export async function liveStatus(id: string, env: NodeJS.ProcessEnv = process.env): Promise<LiveStatus | undefined> {
  if (!readLiveFile(id, env)) return undefined;
  return (await ask(id, "GET", "/state", env)) as LiveStatus;
}

/** Pauses the agent of `id`: its next call waits until `liveResume`. */
export async function livePause(id: string, env: NodeJS.ProcessEnv = process.env): Promise<LiveStatus> {
  // The command the person typed, so the agent is told who paused it (`turno browser pause` inside turno).
  return (await ask(id, "POST", "/pause", env, { by: `${names().browser} pause` })) as LiveStatus;
}

export async function liveResume(id: string, env: NodeJS.ProcessEnv = process.env): Promise<LiveStatus> {
  return (await ask(id, "POST", "/resume", env)) as LiveStatus;
}

/**
 * A link that opens the view once, within two minutes. It carries a one-time code: open it,
 * do not print or log it.
 */
export async function liveLink(id: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  return ((await ask(id, "POST", "/link", env)) as { url: string }).url;
}
