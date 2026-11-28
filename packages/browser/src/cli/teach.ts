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
  str,
  style,
} from "turno-core/cli";
import { tildify } from "turno-core/paths";
import type { TeachState } from "../live-server.js";
import type { Ctx } from "./context.js";
import { needIdentity } from "./flows.js";

/**
 * `teach <id>`: teach mode from the shell (`teach.ts`). The person shows a flow once in the
 * identity's Chrome window and it is saved as a normal flow. With --name it starts teaching (the
 * browser starts first when no server runs, through the identity's background server); at a
 * terminal it then waits: Enter saves every step as shown, Ctrl-C drops them, and the side
 * panel's review saves or drops them too. --stop ends the listening and leaves the review to the
 * side panel; --save and --cancel end a teach mode started elsewhere.
 */

export const TEACH_JSON = jsonOutput(["identity", "phase", "name", "steps", "file"]);

const TEACH_FLAGS: FlagSpec = {
  name: { type: "string" },
  url: { type: "string" },
  overwrite: { type: "boolean" },
  stop: { type: "boolean" },
  save: { type: "boolean" },
  cancel: { type: "boolean" },
  ...JSON_FLAG,
};

/** One line of what teach mode holds. */
function describe(state: TeachState): string {
  switch (state.phase) {
    case "idle":
      return "teach mode is off";
    case "teaching":
      return `teaching "${state.name}": ${state.steps.length} step${state.steps.length === 1 ? "" : "s"} so far`;
    case "review":
      return `"${state.name}" waits for its review in the side panel (${state.steps.length} steps)`;
    case "saved":
      return `saved flow "${state.name}" with ${state.steps} step${state.steps === 1 ? "" : "s"}`;
  }
}

export async function teach(c: Ctx, args: string[], io: Io): Promise<number> {
  const mod = c.api;
  const p = parseFlags(args, TEACH_FLAGS, 1);
  const id = needIdentity(c, p.positionals[0], "teach", io);
  const name = str(p, "name");
  const url = str(p, "url");
  const stop = bool(p, "stop");
  const save = bool(p, "save");
  const cancel = bool(p, "cancel");
  if ([name !== undefined, stop, save, cancel].filter(Boolean).length > 1)
    return fail("--name, --stop, --save and --cancel go one at a time");
  if (url !== undefined && name === undefined) return fail("--url goes with --name");
  const json = bool(p, "json");
  const s = style(io);
  const show = (state: TeachState): number => {
    if (json) {
      emit(io, p, TEACH_JSON, {
        identity: `browser:${id}`,
        phase: state.phase,
        name: "name" in state ? state.name : null,
        steps: state.phase === "saved" ? state.steps : "steps" in state ? state.steps.length : 0,
        file: state.phase === "saved" ? tildify(state.file, io.env) : null,
      });
    } else {
      io.out(describe(state));
      if (state.phase === "saved")
        io.out(
          s.muted(
            `${tildify(state.file, io.env)}; the agent runs it with browser_replay, you with ${c.names.browser} replay ${id} ${state.name}`,
          ),
        );
    }
    return Exit.ok;
  };
  try {
    if (stop) return show(await mod.liveTeach(id, "stop", io.env));
    if (save) return show(await mod.liveTeach(id, "save", io.env));
    if (cancel) return show(await mod.liveTeach(id, "cancel", io.env));
    if (name === undefined) {
      if (!(await mod.liveStatus(id, io.env)))
        return fail(
          `no turno-browser-mcp serves "${id}" right now; ${c.names.browser} teach ${id} --name <flow> starts one`,
        );
      return show(await mod.liveTeach(id, "state", io.env));
    }
    // The browser must run: through the identity's background server when nothing serves it.
    const status = await mod.liveStatus(id, io.env);
    if (!status?.browser) {
      if (status && !mod.backgroundStatus(id, { env: io.env }))
        return fail(
          `the agent's server for "${id}" has not started its browser yet; teach once the agent opened it, or press Teach a flow in its side panel`,
        );
      const holder = mod.inUseBy(id, io.env);
      if (holder && !status) return fail(holder);
      const session = await mod.openBackgroundSession(id, { env: io.env, clientName: c.names.browser });
      try {
        await session.callTool("browser_navigate", { url: url ?? "about:blank" });
      } finally {
        await session.close();
      }
    }
    let state = await mod.liveTeach(id, "start", io.env, {
      name,
      ...(url !== undefined ? { url } : {}),
      ...(bool(p, "overwrite") ? { overwrite: true } : {}),
    });
    if (json || !process.stdin.isTTY) return show(state);
    io.err(
      `teaching "${name}" in the window of "${id}": do the task there. Enter here saves every step as shown (or review it in the side panel); Ctrl-C drops it.`,
    );
    state = await waitForTeach(id, io, mod.liveTeach);
    return show(state);
  } catch (error) {
    return fail((error as Error).message);
  }
}

/** Waits at a terminal until teach mode ends: Enter saves, Ctrl-C cancels, or the panel ends it. */
async function waitForTeach(
  id: string,
  io: Io,
  liveTeach: (id: string, action: "state" | "save" | "cancel", env: NodeJS.ProcessEnv) => Promise<TeachState>,
): Promise<TeachState> {
  const stdin = process.stdin;
  return await new Promise<TeachState>((resolve, reject) => {
    let done = false;
    let shown = -1;
    const finish = (p: Promise<TeachState>) => {
      if (done) return;
      done = true;
      clearInterval(timer);
      stdin.off("data", onData);
      process.off("SIGINT", onInt);
      stdin.pause();
      p.then(resolve, reject);
    };
    const onData = (d: Buffer) => {
      if (d.includes(0x0a) || d.includes(0x0d)) finish(liveTeach(id, "save", io.env));
    };
    const onInt = () => finish(liveTeach(id, "cancel", io.env));
    const timer = setInterval(() => {
      liveTeach(id, "state", io.env).then(
        (state) => {
          if (state.phase === "teaching" && state.steps.length !== shown) {
            shown = state.steps.length;
            io.err(`  ${shown} step${shown === 1 ? "" : "s"}`);
          }
          if (state.phase === "saved" || state.phase === "idle") finish(Promise.resolve(state));
        },
        (error: unknown) => finish(Promise.reject(error as Error)),
      );
    }, 1000);
    stdin.on("data", onData);
    stdin.resume();
    process.once("SIGINT", onInt);
  });
}
