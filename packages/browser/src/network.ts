import { type SecretStore, secretStore } from "turno-core/secrets";
import { names } from "./names.js";

/**
 * Opt-in network and user agent settings of an identity (identity.json format 11), both off by
 * default and the user's choice: a real Chrome on the user's own connection is already
 * the most coherent browser a site can see, and these settings can only keep it coherent or
 * break it. The docs say what each one costs.
 *
 * `userAgent: "coherent"` presents the identity as the installed Chrome, as one set, verified
 * at every launch:
 *
 * - the user agent string is Chrome's own reduced one for this OS and the installed major
 *   version, so a headless Chrome no longer says `HeadlessChrome` (headed, it is unchanged);
 * - the client hints (`Sec-CH-UA*`, `navigator.userAgentData`: brands, full version list,
 *   platform, platform version, architecture) and `navigator.platform` stay Chrome's real ones;
 * - the languages and the time zone are the identity's (`languages`/`locale`, `timezone`) or,
 *   without them, the system's.
 *
 * The platform and the Chrome version are never configurable. Measured with Chrome 157: no
 * DevTools override reaches `navigator.platform` in a dedicated worker, and a popup's first
 * request carries the real `Sec-CH-UA-Platform` and platform version, so another platform would
 * be a partial override however it is applied (and WebGL, fonts and TLS would still say the real
 * one). A typed user agent string is refused for the same reason.
 *
 * `proxy` sends the identity's traffic through a proxy. The credentials are never written in
 * identity.json: `password` (and `username`, when it is one) is a `keychain:<item>` reference
 * read from the secret store at launch, and both values join the redactor, so no tool result
 * shows them. WebRTC is kept on the proxy (`disable_non_proxied_udp`), so it does not show the
 * direct address.
 */

/** The values of `userAgent`. */
const USER_AGENT_MODES = ["coherent"] as const;
export type UserAgentMode = (typeof USER_AGENT_MODES)[number];

/** identity.json `proxy`. */
export interface ProxySettings {
  /** `http://`, `https://`, `socks4://` or `socks5://` with a host and an optional port. */
  server: string;
  /** A user name, or a `keychain:<item>` reference to one. */
  username?: string;
  /** Always a `keychain:<item>` reference. */
  password?: string;
}

const PROXY_SCHEMES = new Set(["http:", "https:", "socks4:", "socks5:"]);
const KEYCHAIN = "keychain:";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Problems with a `proxy.server` value; empty when it is valid. */
function serverProblems(server: unknown): string[] {
  if (typeof server !== "string" || !server.trim())
    return ['proxy.server must be a URL like "http://proxy.example.com:8080"'];
  let url: URL;
  try {
    url = new URL(server);
  } catch {
    return [`proxy.server "${server}" is not a URL (like "http://proxy.example.com:8080")`];
  }
  if (!PROXY_SCHEMES.has(url.protocol))
    return ["proxy.server must start with http://, https://, socks4:// or socks5://"];
  if (url.username || url.password)
    return [
      "proxy.server must not carry a user name or password: put the user name in proxy.username and the password in the secret store (proxy.password: keychain:<item>)",
    ];
  if (!url.hostname) return ["proxy.server needs a host"];
  if ((url.pathname && url.pathname !== "/") || url.search || url.hash)
    return ["proxy.server is a host and port only, with no path or query"];
  return [];
}

/** Problems with the format 11 keys alone (combinations with the engine keys: `networkEngineClash`). */
export function networkProblems(v: Record<string, unknown>, out: string[]): void {
  if (
    v.userAgent !== undefined &&
    v.userAgent !== "auto" &&
    v.userAgent !== false &&
    !(USER_AGENT_MODES as readonly unknown[]).includes(v.userAgent)
  ) {
    out.push(
      'userAgent must be "coherent", "auto" (the default: coherent in a headless Chrome) or false: turno builds the user agent from the installed Chrome and never takes a typed one, which would contradict the client hints, WebGL, fonts and TLS',
    );
  }
  if (v.proxy === undefined || v.proxy === false) return;
  const p = v.proxy;
  if (!isObject(p)) {
    out.push('proxy must be an object like { "server": "http://proxy.example.com:8080" }');
    return;
  }
  out.push(...serverProblems(p.server));
  // A trace keeps the launch options, the proxy password among them; the recorder would delete
  // every trace, so the pair is refused up front instead.
  if (p.password !== undefined && isObject(v.record) && v.record.traces === true)
    out.push(
      "record.traces does not go with a proxy password: a trace keeps the browser's launch options, the password included. Record flows and screenshots, or use a proxy without a password",
    );
  if (p.username !== undefined && (typeof p.username !== "string" || !p.username.trim() || /[\r\n]/.test(p.username)))
    out.push("proxy.username must be a user name or a keychain:<item> reference");
  if (p.password !== undefined) {
    if (typeof p.password !== "string" || !p.password.startsWith(KEYCHAIN) || p.password.length <= KEYCHAIN.length)
      out.push(
        `proxy.password must be a keychain:<item> reference (store it with: ${names().secretSet("<item>")}): identity.json never holds a password`,
      );
  }
  if (p.password !== undefined && p.username === undefined) out.push("proxy.password needs proxy.username");
  if (p.username !== undefined && p.password === undefined)
    out.push("proxy.username needs proxy.password (a keychain:<item> reference)");
  if (
    p.username !== undefined &&
    typeof p.server === "string" &&
    /^socks[45]:/.test(p.server) &&
    !serverProblems(p.server).length
  )
    out.push("Chrome cannot sign in to a SOCKS proxy: use an http:// or https:// proxy for one that needs a password");
  for (const k of Object.keys(p))
    if (!["server", "username", "password"].includes(k)) out.push(`unknown key "proxy.${k}"`);
}

/**
 * Why an engine cannot apply these settings. Attach mode drives the user's own Chrome, whose
 * user agent and network turno does not change; read mode is Lightpanda, which presents its
 * own user agent and was not checked with a proxy; Camoufox is Firefox, which sends no client
 * hints at all, so `userAgent` describes nothing there (a proxy works).
 */
export function networkEngineClash(
  engine: string,
  settings: { userAgent?: unknown; proxy?: unknown },
): string | undefined {
  // `"auto"` and `false` ask for nothing: the default resolves to off on these engines.
  const userAgent = settings.userAgent === "coherent";
  const asked = [userAgent && "userAgent", settings.proxy !== undefined && settings.proxy !== false && "proxy"].filter(
    Boolean,
  ) as string[];
  if (!asked.length) return undefined;
  if (engine === "attach")
    return `${asked.join(" and ")} ${asked.length > 1 ? "do" : "does"} not go with attach mode: that is your own Chrome, and turno does not change its user agent or network. Drop ${asked.length > 1 ? "them" : "it"}, or drop attach`;
  if (engine === "lightpanda")
    return `${asked.join(" and ")} ${asked.length > 1 ? "do" : "does"} not go with engine "lightpanda": read mode presents Lightpanda's own user agent and was not checked with a proxy. Use engine "chrome"`;
  if (engine === "camoufox" && userAgent)
    return 'userAgent does not go with engine "camoufox": Camoufox is Firefox, which sends no client hints, and it presents its own values. Drop userAgent (proxy works with Camoufox)';
  return undefined;
}

/** A proxy ready for Playwright's `proxy` launch option. */
export interface ResolvedProxy {
  server: string;
  username?: string;
  password?: string;
}

/**
 * Reads the proxy's credentials from the secret store. Every value read is handed to `secret`
 * (the redactor) before anything else sees it, with the `Proxy-Authorization` form Chrome sends
 * for a plain http:// request through the proxy. Throws without the value when an item is
 * missing or the store cannot be read.
 */
export async function resolveProxy(
  proxy: ProxySettings,
  env: NodeJS.ProcessEnv,
  secret: (value: string, label: string) => void,
  store: SecretStore | undefined = secretStore(env),
): Promise<ResolvedProxy> {
  const out: ResolvedProxy = { server: proxy.server };
  if (proxy.username === undefined || proxy.password === undefined) return out;
  const read = async (ref: string, what: string): Promise<string> => {
    if (!ref.startsWith(KEYCHAIN)) return ref;
    const item = ref.slice(KEYCHAIN.length);
    if (!store)
      throw new Error(
        `the proxy ${what} is ${ref}, but this machine has no secret store (macOS Keychain or libsecret)`,
      );
    let value: string | undefined;
    try {
      value = await store.get(item);
    } catch {
      throw new Error(`the secret store could not read the proxy ${what} (${ref})`);
    }
    if (value === undefined || value === "")
      throw new Error(
        `the secret store has no item "${item}" for the proxy ${what} (store it with: ${names().secretSet(item)})`,
      );
    return value;
  };
  const username = await read(proxy.username, "user name");
  const password = await read(proxy.password, "password");
  if (proxy.username.startsWith(KEYCHAIN)) secret(username, "proxy user name");
  secret(password, "proxy password");
  const basic = Buffer.from(`${username}:${password}`).toString("base64");
  // "password" in the label: a saved trace holding it is deleted (recordings.ts).
  secret(basic, "proxy password, Basic encoded");
  return { ...out, username, password };
}

/**
 * Chrome switches that go with a proxy: WebRTC uses the proxy or no UDP at all, so a page
 * cannot read the direct address through a peer connection.
 */
export const CHROME_PROXY_ARGS: readonly string[] = Object.freeze([
  "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
]);

/** The same for Firefox (Camoufox): ICE candidates only through the proxy. */
export const FIREFOX_PROXY_PREFS: Readonly<Record<string, boolean>> = Object.freeze({
  "media.peerconnection.ice.proxy_only_if_behind_proxy": true,
  "media.peerconnection.ice.default_address_only": true,
});

/** The OS tokens of Chrome's reduced user agent string, frozen by Chrome for every version of each OS. */
const UA_PLATFORM: Readonly<Record<string, string>> = {
  darwin: "Macintosh; Intel Mac OS X 10_15_7",
  win32: "Windows NT 10.0; Win64; x64",
  linux: "X11; Linux x86_64",
};

/**
 * Chrome's own reduced user agent string for this OS and major version, as a headed Chrome
 * sends it (the minor, build and patch are always 0 there).
 */
export function reducedUserAgent(major: number, platform: NodeJS.Platform = process.platform): string {
  const os = UA_PLATFORM[platform] ?? UA_PLATFORM.linux;
  return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

/** What a page reads, for the launch check. */
export interface ObservedIdentity {
  userAgent: string;
  platform: string;
  languages: string[];
  timezone: string;
  /** `Intl.DateTimeFormat().resolvedOptions().locale`. */
  intlLocale: string;
  uaData?: {
    brands: { brand: string; version: string }[];
    platform: string;
    mobile: boolean;
    /** The high entropy values (`getHighEntropyValues`), which a user agent override can blank. */
    high?: HighEntropyValues;
  } | null;
}

/** The client hints high entropy values the launch check reads. */
interface HighEntropyValues {
  fullVersionList: { brand: string; version: string }[];
  architecture: string;
  platformVersion: string;
}

/**
 * What the identity should present: `languages` and `timezone` are what was asked for, else
 * unchecked; `high` is the metadata a headless Chrome was given, which every page must read back.
 */
export interface ExpectedIdentity {
  languages?: string[];
  timezone?: string;
  high?: HighEntropyValues;
}

/** The `navigator.userAgentData.platform` and `navigator.platform` prefixes for each UA OS token. */
const PLATFORMS: readonly { ua: RegExp; hints: string; navigator: RegExp }[] = [
  { ua: /Macintosh/, hints: "macOS", navigator: /^Mac/ },
  { ua: /Windows/, hints: "Windows", navigator: /^Win/ },
  { ua: /CrOS/, hints: "Chrome OS", navigator: /^Linux/ },
  { ua: /Android/, hints: "Android", navigator: /^Linux/ },
  { ua: /X11|Linux/, hints: "Linux", navigator: /^Linux/ },
];

const base = (tag: string) => tag.split("-")[0]!.toLowerCase();

const highEntropyKey = (h: HighEntropyValues) =>
  JSON.stringify([h.fullVersionList.map((b) => `${b.brand} ${b.version}`), h.architecture, h.platformVersion]);

/**
 * Every contradiction between what a page reads and what the identity presents; empty when
 * the set is coherent. Pure, so the bench and the unit tests use it too.
 */
export function coherenceProblems(o: ObservedIdentity, expected: ExpectedIdentity = {}): string[] {
  const out: string[] = [];
  if (/HeadlessChrome/.test(o.userAgent)) out.push("the user agent says HeadlessChrome");
  const major = /Chrome\/(\d+)\./.exec(o.userAgent)?.[1];
  if (!major) out.push("the user agent has no Chrome version");
  if (!o.uaData) out.push("navigator.userAgentData is missing");
  else {
    if (major && !o.uaData.brands.some((b) => /^(Google Chrome|Chromium)$/.test(b.brand) && b.version === major))
      out.push(
        `the client hints brands (${o.uaData.brands.map((b) => `${b.brand} ${b.version}`).join(", ")}) do not name Chrome ${major}`,
      );
    const os = PLATFORMS.find((p) => p.ua.test(o.userAgent));
    if (os && o.uaData.platform !== os.hints)
      out.push(`the user agent is ${os.hints} but the client hints platform is ${o.uaData.platform}`);
    if (os && !os.navigator.test(o.platform))
      out.push(`the user agent is ${os.hints} but navigator.platform is ${o.platform}`);
    if (o.uaData.mobile) out.push("the client hints say mobile");
    const high = o.uaData.high;
    // Chrome on Linux reports an empty platform version, as a person's Chrome there does.
    const versionless = o.uaData.platform === "Linux";
    if (high && (!high.fullVersionList.length || !high.architecture || (!high.platformVersion && !versionless)))
      out.push("the client hints high entropy values (full version list, architecture, platform version) are blank");
    else if (high && expected.high && highEntropyKey(high) !== highEntropyKey(expected.high))
      out.push(
        `the client hints high entropy values (${high.architecture || "no architecture"}, platform version ${high.platformVersion || "empty"}) differ from this Chrome's own (${expected.high.architecture}, platform version ${expected.high.platformVersion || "empty"})`,
      );
    else if (
      high &&
      major &&
      !high.fullVersionList.some(
        (b) => /^(Google Chrome|Chromium)$/.test(b.brand) && majorOf(b.version) === Number(major),
      )
    )
      out.push(`the client hints full version list does not name Chrome ${major}`);
  }
  if (expected.languages?.length) {
    if (JSON.stringify(o.languages) !== JSON.stringify(expected.languages))
      out.push(`navigator.languages is ${o.languages.join(", ")}, not ${expected.languages.join(", ")}`);
  }
  const first = expected.languages?.[0] ?? o.languages[0];
  if (first && base(o.intlLocale) !== base(first))
    out.push(
      `dates and numbers are formatted in ${o.intlLocale}, but the first language is ${first}` +
        (process.platform === "darwin"
          ? " (on macOS Chrome takes that from the system language, not from flags: set languages to start with it, or change the macOS language)"
          : ""),
    );
  if (expected.timezone && o.timezone !== expected.timezone)
    out.push(`the time zone is ${o.timezone}, not ${expected.timezone}`);
  return out;
}

/** Runs in a page: what `coherenceProblems` checks. */
export const OBSERVE_SCRIPT = `async () => {
  const d = navigator.userAgentData;
  const high = d ? await d.getHighEntropyValues(["fullVersionList", "architecture", "platformVersion"]) : null;
  return {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    languages: Array.from(navigator.languages || []),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    intlLocale: Intl.DateTimeFormat().resolvedOptions().locale,
    uaData: d
      ? {
          brands: d.brands.map((b) => ({ brand: b.brand, version: b.version })),
          platform: d.platform,
          mobile: d.mobile,
          high: {
            fullVersionList: (high.fullVersionList || []).map((b) => ({ brand: b.brand, version: b.version })),
            architecture: high.architecture || "",
            platformVersion: high.platformVersion || "",
          },
        }
      : null,
  };
}`;

/** The installed Chrome's major version from a version string like "157.0.8103.79". */
export function majorOf(version: string | undefined): number | undefined {
  const m = /^(\d+)\./.exec(version ?? "");
  return m ? Number(m[1]) : undefined;
}
