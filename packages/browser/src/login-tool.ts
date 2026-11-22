import type { Frame, Locator, Page } from "patchright-core";
import type { SecretStore } from "turno-core/secrets";
import type { IdentityRef } from "./engine.js";
import type { HumanInput } from "./human-input.js";
import type { IdentityPolicy } from "./policy.js";
import type { Redactor, VaultGuard } from "./redact.js";
import { totp, totpSecondsLeft } from "./totp.js";
import type { TurnoTool } from "./tools.js";
import { type ToolSchema, upstream } from "./upstream.js";
import { type Credential, VaultError, type VaultSite, originAllowed, readCredential, vaultSite } from "./vault.js";
import { names as commandNames } from "./names.js";

/**
 * `browser_login`: fills a site's username, password and current one-time code from
 * the identity's vault into the sign-in form of the current page. The model names the site; it
 * never sees, sends or receives a value:
 *
 * - The page (its main frame) must be on one of the origins the site was stored with, and only
 *   frames of those origins are filled, so a model led to another site cannot spend the
 *   credentials there.
 * - A password goes only into `<input type="password">`; a username and a code only into text
 *   inputs. A field the model names by ref must pass the same check.
 * - Before anything is filled, the values join the host's redactor, so no result or error of
 *   this server shows them from then on, and the page is held by the vault guard, which refuses
 *   the script tools on it until it navigates.
 * - It does not submit unless the identity chose `turno browser vault submit <id> auto`: the
 *   model clicks the sign-in button itself, as a separate, visible step.
 */

/** What the host gives `browser_login`. */
export interface VaultAccess {
  identity: IdentityRef;
  redactor: Redactor;
  guard: VaultGuard;
  /** The secret store (tests inject a fake); default: this machine's. */
  store?: SecretStore;
  /**
   * Runs before a value goes into the page: a recording saves its trace and holds the page,
   * so the fill is never traced or screenshotted (`recordings.ts`).
   */
  beforeFill?: (page: Page) => Promise<void>;
  /**
   * Human-like input, when the identity's humanize is on: each value is typed key by key into
   * its field, as `browser_type` would. Keys go to Chrome's input pipeline and nowhere else:
   * not into a result (the redactor), a trace (`beforeFill` stopped it) or a log.
   */
  input?: HumanInput;
  /** The identity's policy as the server started: TOTP off, or never submitting (`policy.ts`). */
  policy?: IdentityPolicy;
}

type Field = "username" | "password" | "code";

const TEXT =
  ':not([type="password"]):not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="button"])';
const SELECTORS: Record<Field, string> = {
  password: 'input[type="password"]',
  username: [
    'input[autocomplete~="username" i]',
    'input[type="email"]',
    'input[autocomplete~="email" i]',
    'input[name*="user" i]',
    'input[id*="user" i]',
    'input[name*="email" i]',
    'input[id*="email" i]',
    'input[name*="login" i]',
    'input[id*="login" i]',
    'input[name="identifier" i]',
  ]
    .map((s) => `${s}${TEXT}`)
    .join(", "),
  code: [
    'input[autocomplete="one-time-code" i]',
    'input[name*="otp" i]',
    'input[id*="otp" i]',
    'input[name*="totp" i]',
    'input[name*="2fa" i]',
    'input[name*="mfa" i]',
    'input[name*="code" i]',
    'input[id*="code" i]',
  ]
    .map((s) => `${s}${TEXT}`)
    .join(", "),
};

/** How long a filled one-time code stays redacted. */
const CODE_REDACT_MS = 10 * 60_000;
/** A code with less than this left is not used; the tool waits for the next one. */
const MIN_CODE_SECONDS = 3;

function schema(): ToolSchema {
  const z = upstream().utils.z;
  const ref = (what: string) =>
    z
      .string()
      .optional()
      .describe(
        `Ref (from the page snapshot) or selector of the ${what} field, only when the tool does not find it by itself`,
      );
  return {
    name: "browser_login",
    title: "Fill a sign-in form from the vault",
    description: [
      "Fill the sign-in form of the current page with the username, password and current one-time code stored for a site in this browser identity's vault.",
      "You name the site; the values are never shown to you, and they are hidden from every later result of this server.",
      "The current page must be on the site's own sign-in page (the origins it was stored with).",
      "Fields found on the page are filled (a two-step sign-in needs one call per step). It does not submit the form unless the identity allows it: click the sign-in button yourself afterwards.",
      `The person adds credentials with \`${commandNames().browser} vault add <identity> <site>\`.`,
    ].join(" "),
    inputSchema: z.object({
      site: z.string().describe("The site key in the vault, for example github"),
      usernameField: ref("username"),
      passwordField: ref("password"),
      codeField: ref("one-time code"),
    }),
    type: "action",
  };
}

/** The element's type and the origin of its frame, to check a field before a value goes in. */
async function describeField(locator: Locator): Promise<{ tag: string; type: string; origin: string } | undefined> {
  return await locator
    .evaluate(
      (el) => ({
        tag: el.tagName.toLowerCase(),
        type: ((el as HTMLInputElement).type || "text").toLowerCase(),
        origin: el.ownerDocument.location.origin,
      }),
      undefined,
      {
        timeout: 2_000,
      },
    )
    .catch(() => undefined);
}

const TEXT_TYPES = new Set(["text", "email", "tel", "number", "search", "url"]);

function fits(field: Field, d: { tag: string; type: string }): boolean {
  if (d.tag !== "input") return false;
  return field === "password" ? d.type === "password" : TEXT_TYPES.has(d.type);
}

/** The first visible field of this kind in the allowed frames, main frame first. */
async function findField(frames: Frame[], field: Field): Promise<Locator | undefined> {
  for (const frame of frames) {
    const locator = frame.locator(SELECTORS[field]).filter({ visible: true }).first();
    if ((await locator.count().catch(() => 0)) > 0) return locator;
  }
  return undefined;
}

/** A field the model named: a snapshot ref or a selector, checked like a found one. */
async function namedField(page: Page, target: string, field: Field, site: VaultSite): Promise<Locator> {
  const locator = (/^(f\d+)?e\d+$/.test(target) ? page.getByRef(target) : page.locator(target)).first();
  const d = await describeField(locator);
  if (!d) throw new VaultError(`the ${field} field ${target} is not on the page; take a new snapshot`);
  if (!fits(field, d))
    throw new VaultError(
      `${target} is a ${d.tag}${d.tag === "input" ? ` of type ${d.type}` : ""}, not a ${field === "password" ? "password field" : "text field"}; the ${field} goes only into one`,
    );
  if (!site.origins.includes(d.origin))
    throw new VaultError(
      `${target} is in a frame of ${d.origin}, not one of the site's origins (${site.origins.join(", ")})`,
    );
  return locator;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The tool. Its schema is built on first use, so importing the registry does not load the bundle. */
export function loginTool(): TurnoTool {
  let built: ToolSchema | undefined;
  return {
    get schema() {
      built ??= schema();
      return built;
    },
    async handle(ctx, params) {
      const vault = ctx.vault;
      if (!vault) throw new VaultError("browser_login needs a browser identity: this server runs without --identity");
      const recording = recordingReason(ctx.config);
      if (recording)
        throw new VaultError(
          `browser_login is off while this server records ${recording} (it would keep the filled values); start it without that option`,
        );
      const { id, env } = vault.identity;
      const siteKey = params.site as string;
      const found = vaultSite(id, siteKey, env);
      if (!found)
        throw new VaultError(
          `identity "${id}" has no credentials for "${siteKey}" in its vault; the person adds them with: ${commandNames().browser} vault add ${id} ${siteKey} --url <sign-in page>`,
        );
      const { site } = found;
      // The policy wins over the vault's own submit setting.
      const submit = vault.policy?.autoSubmit === false ? "confirm" : found.submit;
      const totpOff = vault.policy?.disabled?.includes("totp") === true;
      const page = ctx.stock?.currentPage();
      if (!page) throw new VaultError("no page is open; navigate to the sign-in page first");
      if (!originAllowed(site, page.url())) {
        throw new VaultError(
          `this page is on ${safeOrigin(page.url())}, not on an origin "${siteKey}" was stored for (${site.origins.join(", ")}); navigate to its sign-in page first`,
        );
      }
      const frames = page.frames().filter((f) => originAllowed(site, f.url()));

      const fields = new Map<Field, Locator>();
      for (const field of ["username", "password", "code"] as const) {
        const named = params[`${field}Field`] as string | undefined;
        const locator = named ? await namedField(page, named, field, site) : await findField(frames, field);
        if (locator) fields.set(field, locator);
      }
      if (!fields.size) {
        throw new VaultError(
          `found no username, password or one-time code field on ${safeOrigin(page.url())}; take a snapshot and pass the field's ref as usernameField, passwordField or codeField`,
        );
      }

      const credential: Credential = await readCredential(id, siteKey, {
        env,
        ...(vault.store ? { store: vault.store } : {}),
      });
      const skipped: string[] = [];
      let code: string | undefined;
      if (fields.has("code")) {
        if (totpOff) {
          fields.delete("code");
          skipped.push("the one-time code (the identity's policy turns TOTP off)");
        } else if (!credential.totp) {
          fields.delete("code");
          skipped.push("the one-time code (no TOTP secret is stored for this site)");
        } else {
          const left = totpSecondsLeft(credential.totp);
          if (left < MIN_CODE_SECONDS) await sleep(left * 1000 + 200);
          code = totp(credential.totp);
        }
      }
      await vault.beforeFill?.(page);
      // Redact first: from here on no result or error of this server shows a value.
      vault.redactor.add(credential.username, `${siteKey} username`);
      vault.redactor.add(credential.password, `${siteKey} password`);
      if (code) vault.redactor.add(code, `${siteKey} one-time code`, CODE_REDACT_MS);
      vault.guard.mark(page);

      const values: Record<Field, string | undefined> = {
        username: credential.username,
        password: credential.password,
        code,
      };
      const filled: Field[] = [];
      let last: Locator | undefined;
      // With humanize on, the fields are clicked into and typed key by key (`human-input.ts`).
      const humanized = vault.input && vault.input.levelFor(page) !== "off" ? vault.input : undefined;
      for (const [field, found] of fields) {
        const locator = humanized ? humanized.wrapLocator(found, page) : found;
        try {
          await locator.fill(values[field]!, { timeout: 5_000 });
        } catch (error) {
          throw new VaultError(`could not fill the ${field} field: ${vault.redactor.text(firstLine(error))}`);
        }
        filled.push(field);
        last = locator;
      }

      const names = filled.map((f) => (f === "code" ? "one-time code" : f));
      const lines = [
        `Filled the ${list(names)} of "${siteKey}" from the vault of identity "${id}" on ${safeOrigin(page.url())}. The values are hidden as [vault: ...] in every result.`,
      ];
      if (skipped.length) lines.push(`Not filled: ${skipped.join("; ")}.`);
      if (submit === "auto" && last) {
        await last.press("Enter", { timeout: 5_000 });
        await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {});
        lines.push("Submitted the form (this identity submits sign-ins itself). Check the page below for the result.");
      } else {
        lines.push("Nothing was submitted: click the sign-in button yourself (it is in the snapshot below).");
      }
      const snapshot = ctx.stock ? await ctx.stock.call("browser_snapshot", {}, { snapshot: true }) : undefined;
      const text = [`### Result`, ...lines].join("\n");
      return { content: [{ type: "text", text }, ...(snapshot?.content ?? [])] };
    },
  };
}

/** What of the server's config records page content a filled value would end up in. */
export function recordingReason(config: unknown): string | undefined {
  const c = config as {
    saveSession?: boolean;
    saveVideo?: unknown;
    capabilities?: string[];
    browser?: { contextOptions?: { recordHar?: unknown; recordVideo?: unknown } };
  };
  if (c.saveSession) return "the session (--save-session)";
  if (c.saveVideo || c.browser?.contextOptions?.recordVideo) return "video (--save-video)";
  if (c.browser?.contextOptions?.recordHar) return "a HAR file (recordHar)";
  if (c.capabilities?.includes("devtools")) return "traces (the devtools capability)";
  return undefined;
}

function list(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "this page";
  }
}

function firstLine(error: unknown): string {
  return String((error as Error)?.message ?? error).split("\n")[0] ?? "";
}
