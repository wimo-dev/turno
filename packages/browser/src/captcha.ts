import type { Page } from "patchright-core";
import { secretStore } from "turno-core/secrets";
import { type CaptchaSettings, captchaTimeoutMs } from "./opt-in-settings.js";
import { recordSolve } from "./reputation.js";
import { readIdentitySettings } from "./settings.js";
import type { TurnoTool } from "./tools.js";
import { type ToolResult, type ToolSchema, upstream } from "./upstream.js";
import { names } from "./names.js";

/**
 * Captcha solving, off by default (identity.json `captcha`). `browser_solve_captcha` finds a
 * captcha widget on the current tab, sends its kind, site key and the page URL to the solver
 * service the person configured, and puts the token it returns into the page's response field
 * (and the widget's callback, when it names one). The agent then submits the form itself.
 *
 * What it is and is not:
 *
 * - The solver is a third party: it sees the page URL and the widget, and usually loads the
 *   page on its own machines to answer. Its key comes from the secret store through a
 *   `keychain:` reference, joins the redactor, and never appears in a tool argument or result.
 * - It answers only the widgets that hand back a token (`WIDGETS`). A full-page "checking your
 *   browser" interstitial, a "verify it's you" prompt or a block page is left to the person.
 * - Every attempt, solved or not, is one line in the identity's reputation log (`reputation.ts`)
 *   with the host name, the widget kind and the provider: never the token or the key.
 * - Many sites' terms forbid solving their captchas by machine; the docs say so and say it is
 *   meant for the person's own accounts.
 */

/** The widgets a token answers, with the task type of the task protocol and where the token goes. */
export const WIDGETS = {
  recaptcha: { task: "RecaptchaV2TaskProxyless", fields: ["g-recaptcha-response"], label: "reCAPTCHA v2" },
  hcaptcha: {
    task: "HCaptchaTaskProxyless",
    fields: ["h-captcha-response", "g-recaptcha-response"],
    label: "hCaptcha",
  },
  turnstile: { task: "TurnstileTaskProxyless", fields: ["cf-turnstile-response"], label: "Turnstile" },
} as const;

type WidgetKind = keyof typeof WIDGETS;

/** A widget found on a page. The site key is public: it is in the page's markup. */
interface CaptchaWidget {
  kind: WidgetKind;
  siteKey: string;
  /** reCAPTCHA's invisible mode. */
  invisible?: boolean;
  /** The global function the widget calls with the token (`data-callback`), when it names one. */
  callback?: string;
}

interface SolveRequest {
  widget: CaptchaWidget;
  pageUrl: string;
  signal?: AbortSignal;
}

/** A solver service, behind one method. */
export interface CaptchaSolver {
  /** How the result names it: "task-api at solver.example.com". */
  readonly label: string;
  /** The provider id for the reputation log. */
  readonly provider: string;
  solve(request: SolveRequest): Promise<{ token: string }>;
}

class SolverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SolverError";
  }
}

type Fetch = typeof fetch;

/**
 * The task protocol many solver services share: `POST <endpoint>/createTask` with the account
 * key and a task, then `POST <endpoint>/getTaskResult` until the task is ready. Errors come back
 * as `errorId` with `errorCode` and `errorDescription`.
 */
export function taskApiSolver(options: {
  endpoint: string;
  key: string;
  fetch?: Fetch;
  /** Waits between polls (ms); the last one repeats. Default: 1 s, 2 s, then every 3 s. */
  polls?: readonly number[];
}): CaptchaSolver {
  const base = options.endpoint.replace(/\/+$/, "");
  const host = new URL(options.endpoint).host;
  const doFetch = options.fetch ?? fetch;
  const polls = options.polls?.length ? options.polls : [1_000, 2_000, 3_000];
  const post = async (path: string, body: Record<string, unknown>, signal?: AbortSignal) => {
    let res: Response;
    try {
      res = await doFetch(`${base}/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientKey: options.key, ...body }),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (signal?.aborted) throw new SolverError("the solver did not answer in time");
      throw new SolverError(`cannot reach ${host}: ${(error as Error).message}`);
    }
    const text = await res.text().catch(() => "");
    if (!res.ok) throw new SolverError(`${host} answered ${res.status}`);
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new SolverError(`${host} did not answer with JSON`);
    }
    if (json.errorId !== undefined && json.errorId !== 0) {
      const code = typeof json.errorCode === "string" ? json.errorCode : `error ${String(json.errorId)}`;
      const why = typeof json.errorDescription === "string" ? `: ${json.errorDescription.slice(0, 200)}` : "";
      throw new SolverError(`${host} refused the task (${code}${why})`);
    }
    return json;
  };
  return {
    label: `task-api at ${host}`,
    provider: "task-api",
    async solve({ widget, pageUrl, signal }) {
      const created = await post(
        "createTask",
        {
          task: {
            type: WIDGETS[widget.kind].task,
            websiteURL: pageUrl,
            websiteKey: widget.siteKey,
            ...(widget.invisible ? { isInvisible: true } : {}),
          },
        },
        signal,
      );
      const taskId = created.taskId;
      if (typeof taskId !== "string" && typeof taskId !== "number") throw new SolverError(`${host} gave no task id`);
      for (let i = 0; ; i++) {
        const wait = polls[Math.min(i, polls.length - 1)]!;
        await new Promise<void>((resolve, reject) => {
          if (signal?.aborted) {
            reject(new SolverError("the solver did not answer in time"));
            return;
          }
          const t = setTimeout(resolve, wait);
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(t);
              reject(new SolverError("the solver did not answer in time"));
            },
            { once: true },
          );
        });
        const result = await post("getTaskResult", { taskId }, signal);
        if (result.status === "processing") continue;
        const solution = result.solution as { gRecaptchaResponse?: unknown; token?: unknown } | undefined;
        const token = solution?.gRecaptchaResponse ?? solution?.token;
        if (result.status === "ready" && typeof token === "string" && token) return { token };
        throw new SolverError(`${host} answered without a token`);
      }
    },
  };
}

/** The captcha widgets of a page's main frame, first the ones its markup declares. */
async function findWidgets(page: Page): Promise<CaptchaWidget[]> {
  return await page
    .evaluate(() => {
      const found: { kind: string; siteKey: string; invisible?: boolean; callback?: string }[] = [];
      const declared: [string, string][] = [
        ["recaptcha", ".g-recaptcha[data-sitekey]"],
        ["hcaptcha", ".h-captcha[data-sitekey]"],
        ["turnstile", ".cf-turnstile[data-sitekey]"],
      ];
      for (const [kind, selector] of declared) {
        for (const el of Array.from(document.querySelectorAll(selector))) {
          const siteKey = el.getAttribute("data-sitekey") ?? "";
          const callback = el.getAttribute("data-callback") ?? undefined;
          found.push({
            kind,
            siteKey,
            ...(el.getAttribute("data-size") === "invisible" ? { invisible: true } : {}),
            ...(callback ? { callback } : {}),
          });
        }
      }
      // A widget rendered from script has no declaring element: its frame's URL carries the key.
      for (const frame of Array.from(document.querySelectorAll("iframe[src]"))) {
        let url: URL;
        try {
          url = new URL((frame as HTMLIFrameElement).src);
        } catch {
          continue;
        }
        const add = (kind: string, siteKey: string | null | undefined, invisible?: boolean) => {
          if (siteKey && !found.some((f) => f.kind === kind && f.siteKey === siteKey))
            found.push({ kind, siteKey, ...(invisible ? { invisible } : {}) });
        };
        if (/\/recaptcha\/(api2|enterprise)\/anchor/.test(url.pathname))
          add("recaptcha", url.searchParams.get("k"), url.searchParams.get("size") === "invisible");
        else if (/hcaptcha/.test(url.hostname))
          add("hcaptcha", url.searchParams.get("sitekey") ?? new URLSearchParams(url.hash.slice(1)).get("sitekey"));
        else if (url.hostname === "challenges.cloudflare.com")
          add("turnstile", /\/(0x[0-9A-Za-z_-]{10,})\//.exec(url.pathname)?.[1]);
      }
      return found.filter((f) => f.siteKey);
    })
    .then((list) => list as CaptchaWidget[])
    .catch(() => []);
}

/**
 * Puts a token where the widget's form reads it, and calls the widget's callback. The fields
 * are set from Patchright's isolated world, like every other turno script; the callback is a
 * function of the page's own scripts, so only that call runs in the page's main world.
 */
async function applyToken(
  page: Page,
  widget: CaptchaWidget,
  token: string,
): Promise<{ fields: number; callback: boolean }> {
  const fields = await page.evaluate(
    ({ names, token }: { names: string[]; token: string }) => {
      let set = 0;
      for (const name of names) {
        for (const el of Array.from(document.querySelectorAll(`[name="${name}"], #${name}`))) {
          (el as HTMLTextAreaElement).value = token;
          set++;
        }
      }
      return set;
    },
    { names: [...WIDGETS[widget.kind].fields], token },
  );
  let callback = false;
  if (widget.callback && /^[A-Za-z_$][\w$.]*$/.test(widget.callback)) {
    callback = await page
      .evaluate(
        ({ path, token }: { path: string; token: string }) => {
          let fn: unknown = window;
          for (const part of path.split(".")) fn = (fn as Record<string, unknown> | undefined)?.[part];
          if (typeof fn !== "function") return false;
          (fn as (t: string) => void)(token);
          return true;
        },
        { path: widget.callback, token },
        undefined,
        false,
      )
      .catch(() => false);
  }
  return { fields, callback };
}

/** The configured solver, its key from the secret store; the key joins the redactor first. */
async function resolveSolver(
  ctx: Parameters<TurnoTool["handle"]>[0],
  settings: CaptchaSettings,
): Promise<CaptchaSolver> {
  const vault = ctx.vault!;
  const item = settings.key.slice("keychain:".length);
  const store = vault.store ?? secretStore(vault.identity.env);
  if (!store) throw new SolverError(`captcha.key names ${settings.key}, but this machine has no secret store`);
  const key = await store.get(item).catch(() => undefined);
  if (key === undefined)
    throw new SolverError(
      `the secret store has no item "${item}" for captcha.key (store it with: ${names().secretSet(item)})`,
    );
  vault.redactor.add(key, "captcha solver key");
  return taskApiSolver({
    endpoint: settings.endpoint,
    key,
    ...(ctx.providers?.fetch ? { fetch: ctx.providers.fetch } : {}),
  });
}

function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: `### Error\n${message}` }], isError: true };
}

function solveSchema(): ToolSchema {
  const z = upstream().utils.z;
  return {
    name: "browser_solve_captcha",
    title: "Solve the captcha on the page",
    description: [
      "Solve the captcha widget on the current tab (reCAPTCHA v2, hCaptcha or Turnstile) through the solver service the person configured for this browser identity, and put the token into the page.",
      "Call it only when a captcha stands between you and a step the person asked for on their own account; then submit the form yourself, before the token expires (about two minutes).",
      "It does not answer full-page browser checks, verify-it's-you prompts or block pages: hand those to the person.",
      "The solver sees the page URL and the widget. Every use is logged in the identity's reputation log.",
    ].join(" "),
    inputSchema: z.object({}),
    type: "action",
  };
}

export function solveCaptchaTool(): TurnoTool {
  let schema: ToolSchema | undefined;
  return {
    get schema() {
      schema ??= solveSchema();
      return schema;
    },
    async handle(ctx) {
      const vault = ctx.vault;
      const page = ctx.stock?.currentPage();
      if (!vault || !ctx.stock)
        return fail("browser_solve_captcha needs a browser identity (turno-browser-mcp --identity <id>)");
      const { identity } = vault;
      let settings: CaptchaSettings | undefined;
      try {
        settings = readIdentitySettings(identity.id, identity.env)?.captcha || undefined;
      } catch (error) {
        return fail((error as Error).message);
      }
      if (!settings)
        return fail(
          `captcha solving is off for identity "${identity.id}"; only the person can turn it on (${names().identity("set", identity.id)} --captcha-provider task-api --captcha-endpoint <url> --captcha-key keychain:<item>). Otherwise ask them to answer it in the browser window.`,
        );
      if (!page) return fail("there is no page open: navigate to the page with the captcha first");
      let url: URL;
      try {
        url = new URL(page.url());
      } catch {
        return fail("the current page has no web address");
      }
      if (url.protocol !== "https:" && url.protocol !== "http:") return fail("the current page is not a web page");
      const widgets = await findWidgets(page);
      const widget = widgets[0];
      if (!widget)
        return fail(
          "no captcha widget this tool can answer is on the current page (reCAPTCHA v2, hCaptcha, Turnstile). A full-page browser check, a verify-it's-you prompt or a block page is for the person to handle in the window.",
        );
      const timeoutMs = captchaTimeoutMs(settings);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      timer.unref?.();
      const onAbort = () => controller.abort();
      ctx.signal?.addEventListener("abort", onAbort, { once: true });
      const started = Date.now();
      const log = (ok: boolean) => {
        try {
          recordSolve(identity.id, identity.env, {
            site: url.hostname,
            widget: widget.kind,
            provider: settings.provider,
            ok,
          });
        } catch {
          /* the log is best effort; a full disk must not break a tool call */
        }
      };
      try {
        const solver = ctx.providers?.solver ?? (await resolveSolver(ctx, settings));
        const { token } = await solver.solve({ widget, pageUrl: page.url(), signal: controller.signal });
        const applied = await applyToken(page, widget, token);
        log(true);
        const seconds = ((Date.now() - started) / 1000).toFixed(1);
        const placed =
          applied.fields || applied.callback
            ? `Token put into the page${applied.fields ? ` (${applied.fields} response field${applied.fields === 1 ? "" : "s"})` : ""}${applied.callback ? `; the widget's callback ${widget.callback} ran` : ""}.`
            : "The page has no response field or callback for the token yet; its widget script may not have loaded. Try again after it shows.";
        return {
          content: [
            {
              type: "text",
              text: [
                "### Captcha",
                `Widget: ${WIDGETS[widget.kind].label}${widgets.length > 1 ? ` (the first of ${widgets.length} on the page)` : ""}`,
                `Solver: ${solver.label}, ${seconds} s`,
                placed,
                `Logged in the reputation log of "${identity.id}".`,
                "Next: submit the form now; the token expires in about two minutes.",
              ].join("\n"),
            },
          ],
          ...(applied.fields || applied.callback ? {} : { isError: true }),
        };
      } catch (error) {
        log(false);
        const why = controller.signal.aborted
          ? `the solver did not answer within ${timeoutMs / 1000} s`
          : (error as Error).message;
        return fail(`the captcha was not solved: ${why}. Ask the person to answer it in the browser window.`);
      } finally {
        clearTimeout(timer);
        ctx.signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}
