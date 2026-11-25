import { readFile } from "node:fs/promises";
import type { BrowserContext, Page } from "patchright-core";
import type { Redactor } from "./redact.js";
import {
  MASK,
  STORAGE_READ_TOOLS,
  type StateCookie,
  type StorageState,
  cookieMaskReason,
  maskCookieText,
  maskWebStorageText,
  secretStrings,
  stateHoldsMask,
  unmaskStorageState,
  unmaskStorageValue,
} from "./storage-mask.js";
import type { ToolResult } from "./upstream.js";

/**
 * Keeps session cookie and token values away from the model, whichever tool would show them
 * (`storage-mask.ts` says which values). After every stock call the browser's cookies and the
 * current page's localStorage and sessionStorage are read, and each masked value joins the
 * host's redactor, so the value reads `[masked]` in any result: a cookie tool, `document.cookie`
 * through browser_evaluate, a response body, a console message, a snapshot, a file a tool wrote,
 * the act model's prompt. The storage tools' own lines are masked by the rule too, short values
 * included, and a mask the model writes back stands for the value it hides.
 *
 * What a script can still do: browser_evaluate and browser_run_code_unsafe can transform a value
 * (base64, reversed, split) before returning it, which no redaction of the result catches. The
 * docs' security page lists that and the other limits.
 */

/** Longest a read of the page's web storage may take: a page that is navigating can stall it. */
const STORAGE_READ_MS = 750;

/** The page's localStorage and sessionStorage items, or none when they cannot be read in time. */
async function webStorage(page: Page | undefined): Promise<{ local: Item[]; session: Item[] }> {
  if (!page || page.isClosed()) return { local: [], session: [] };
  const read = async (kind: "localStorage" | "sessionStorage"): Promise<Item[]> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        page[kind].items(),
        new Promise<Item[]>((resolve) => {
          timer = setTimeout(() => resolve([]), STORAGE_READ_MS);
        }),
      ]);
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  };
  const [local, session] = await Promise.all([read("localStorage"), read("sessionStorage")]);
  return { local, session };
}

interface Item {
  name: string;
  value: string;
}

/** What one read found: the cookies and the current page's web storage. */
export interface StorageSeen {
  cookies: StateCookie[];
  local: Item[];
  session: Item[];
}

export class StorageGuard {
  /** The strings to mask for each value read before, so a read of the same cookies costs no rule work. */
  private readonly known = new Map<string, readonly string[]>();
  private readonly patched = new WeakSet<BrowserContext>();

  constructor(private readonly redactor: Redactor) {}

  /** Reads the cookies and the page's web storage; every value the rule masks joins the redactor. */
  async refresh(context: BrowserContext, page: Page | undefined): Promise<StorageSeen> {
    const [cookies, web] = await Promise.all([
      (async () => (await context.cookies()) as unknown as StateCookie[])().catch(() => [] as StateCookie[]),
      webStorage(page),
    ]);
    for (const c of cookies)
      this.mask(`c\u0000${c.httpOnly ? 1 : 0}\u0000${c.name}\u0000${c.value}`, () =>
        cookieMaskReason(c) ? secretStrings(c.value) : [],
      );
    for (const i of [...web.local, ...web.session]) this.mask(`s\u0000${i.value}`, () => secretStrings(i.value));
    return { cookies, ...web };
  }

  /** Hands a value's strings to the redactor (again: the ones still in the browser go last). */
  private mask(key: string, strings: () => readonly string[]): void {
    let found = this.known.get(key);
    if (!found) {
      found = strings();
      this.known.set(key, found);
      // A browser with many sites holds a few thousand cookies; forget the oldest past that.
      if (this.known.size > 8192)
        for (const k of this.known.keys()) if (this.known.delete(k) && this.known.size <= 4096) break;
    }
    for (const s of found) this.redactor.addMasked(s, MASK);
  }

  /** A storage tool's result with its values masked by the rule (short and plain ones too). */
  maskResult(name: string, result: ToolResult, seen: StorageSeen): ToolResult {
    if (!STORAGE_READ_TOOLS.has(name)) return result;
    const mask = name.startsWith("browser_cookie_")
      ? (t: string) => maskCookieText(t, seen.cookies)
      : (t: string) => maskWebStorageText(t, name.startsWith("browser_localstorage_") ? seen.local : seen.session);
    return {
      ...result,
      content: result.content.map((part) =>
        part.type === "text" ? { ...part, text: mask((part as { text: string }).text) } : part,
      ),
    };
  }

  /**
   * A storage write's arguments with each mask replaced by the value it hides, or why the write
   * is refused (a mask that stands for nothing here). Writes without a mask pass as they are.
   */
  async unmaskWrite(
    name: string,
    args: Record<string, unknown>,
    context: BrowserContext,
    page: Page | undefined,
  ): Promise<{ args: Record<string, unknown> } | { error: string }> {
    const written = args.value;
    if (typeof written !== "string" || !written.includes(MASK)) return { args };
    const refuse = (what: string) => ({
      error: `${name}: the value holds ${MASK}, which stands for a value this server hides, and ${what}. Write a value of your own, or leave this one as it is.`,
    });
    if (name === "browser_cookie_set") {
      let host = "";
      try {
        host = page ? new URL(page.url()).hostname : "";
      } catch {
        /* no page URL: the domain must be given */
      }
      const domain = typeof args.domain === "string" && args.domain ? args.domain : host;
      const path = typeof args.path === "string" && args.path ? args.path : "/";
      const cookies = (await context.cookies().catch(() => [])) as StateCookie[];
      const now = cookies.find(
        (c) => c.name === args.name && (c.domain === domain || c.domain === `.${domain}`) && c.path === path,
      );
      if (!now || written !== MASK) return refuse(`no cookie ${String(args.name)} of ${domain}${path} holds one`);
      return { args: { ...args, value: now.value } };
    }
    const key = String(args.key);
    const kind = name === "browser_localstorage_set" ? "localStorage" : "sessionStorage";
    const current = page ? await page[kind].getItem(key).catch(() => null) : null;
    const value = unmaskStorageValue(key, written, current);
    if (value === undefined) return refuse(`the ${kind} item "${key}" of this page holds no masked value there`);
    return { args: { ...args, value } };
  }

  /**
   * Restoring a storage state file that holds masks (browser_storage_state saved it masked)
   * takes each masked value from the browser's live state instead, so the restore keeps the
   * session rather than writing the mask into it. Done on the context itself, where upstream's
   * tool hands it the file.
   */
  patchRestore(context: BrowserContext): void {
    if (this.patched.has(context) || typeof context.setStorageState !== "function") return;
    this.patched.add(context);
    const restore = context.setStorageState.bind(context);
    type Arg = Parameters<BrowserContext["setStorageState"]>[0];
    (context as { setStorageState: (state: Arg) => Promise<void> }).setStorageState = async (state: Arg) => {
      const parsed = (typeof state === "string" ? JSON.parse(await readFile(state, "utf8")) : state) as StorageState;
      if (!stateHoldsMask(parsed)) return await restore(state);
      const live = (await context.storageState()) as unknown as StorageState;
      return await restore(unmaskStorageState(parsed, live).state as unknown as Arg);
    };
  }
}
