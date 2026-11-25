import { execFileSync } from "node:child_process";

/**
 * The operating system's proxy, read the way Chrome reads it. A Chrome that turno starts without
 * a proxy of the identity's own gets no proxy switch at all, so it already follows the system's
 * settings (its NetLog says `"from_system": true`): there is nothing to turn on, only something to
 * report. `show`, `status` and `doctor` say which proxy that is, and with a proxy in use the exit
 * address is checked against the identity's time zone and locale (`exit-geo.ts`).
 *
 * - macOS: `scutil --proxy`, the settings of the network services (HTTPS, HTTP, SOCKS, a PAC
 *   file, auto discovery).
 * - Windows: WinINET's per-user settings in the registry (`ProxyEnable`, `ProxyServer`,
 *   `ProxyOverride`, `AutoConfigURL`), which Chrome uses there.
 * - Linux: on GNOME and its relatives, the `org.gnome.system.proxy` settings (Chrome reads them
 *   through GSettings); elsewhere the environment Chrome inherits (`https_proxy`, `http_proxy`,
 *   `all_proxy`, `auto_proxy`, `no_proxy`, either case).
 *
 * Only what the settings say is read; nothing is resolved (a PAC file is not fetched).
 */

/** A proxy the system sets. */
export interface SystemProxy {
  /** Where it was read: "macOS network settings", "Windows Internet Settings", "GNOME settings", "environment". */
  source: string;
  /** The proxy for https:// pages as a URL (`http://host:port`, `socks5://host:port`); undefined with only a PAC file. */
  server?: string;
  /** A proxy auto-config URL. */
  pac?: string;
  /** Proxy auto discovery (WPAD) is on. */
  autoDetect?: boolean;
  /** Hosts that go direct. */
  direct?: string[];
}

/** One line for `show` and `status`: "http://proxy.example.com:8080 (macOS network settings)". */
export function describeSystemProxy(p: SystemProxy): string {
  const what = p.server ?? (p.pac ? `PAC ${p.pac}` : "auto discovery (WPAD)");
  return `${what} (${p.source})`;
}

const hostPort = (scheme: string, host: string, port: string | number | undefined) => {
  const h = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return port !== undefined && String(port) !== "" && String(port) !== "0"
    ? `${scheme}://${h}:${port}`
    : `${scheme}://${h}`;
};

/** The top-level keys of `scutil --proxy` (nested dictionaries such as `__SCOPED__` are skipped). */
function scutilKeys(text: string): { values: Map<string, string>; arrays: Map<string, string[]> } {
  const values = new Map<string, string>();
  const arrays = new Map<string, string[]>();
  let depth = 0;
  let array: string[] | undefined;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line === "}") {
      depth--;
      if (array && depth === 1) array = undefined;
      continue;
    }
    const m = /^(\S+) : ?(.*)$/.exec(line);
    if (line.endsWith("{")) {
      if (depth === 1 && m && m[2]!.startsWith("<array>")) {
        array = [];
        arrays.set(m[1]!, array);
      }
      depth++;
      continue;
    }
    if (!m) continue;
    if (depth === 2 && array) array.push(m[2]!);
    else if (depth === 1) values.set(m[1]!, m[2]!);
  }
  return { values, arrays };
}

/** The proxy in `scutil --proxy` output, or undefined when none is on. */
export function parseScutilProxy(text: string): SystemProxy | undefined {
  const { values, arrays } = scutilKeys(text);
  const on = (key: string) => values.get(`${key}Enable`) === "1" && !!values.get(`${key}Proxy`);
  const proxy = (key: string, scheme: string) => hostPort(scheme, values.get(`${key}Proxy`)!, values.get(`${key}Port`));
  const server = on("HTTPS")
    ? proxy("HTTPS", "http")
    : on("HTTP")
      ? proxy("HTTP", "http")
      : on("SOCKS")
        ? proxy("SOCKS", "socks5")
        : undefined;
  const pac =
    values.get("ProxyAutoConfigEnable") === "1" ? values.get("ProxyAutoConfigURLString") || undefined : undefined;
  const autoDetect = values.get("ProxyAutoDiscoveryEnable") === "1";
  if (!server && !pac && !autoDetect) return undefined;
  const direct = arrays.get("ExceptionsList");
  return {
    source: "macOS network settings",
    ...(server ? { server } : {}),
    ...(pac ? { pac } : {}),
    ...(autoDetect ? { autoDetect } : {}),
    ...(direct?.length ? { direct } : {}),
  };
}

/** `ProxyServer`: `host:port`, or per scheme `http=host:port;https=host:port;socks=host:port`. */
function winInetServer(value: string): string | undefined {
  const parts = value
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean);
  if (!parts.length) return undefined;
  const withScheme = (target: string, scheme: string) =>
    /^[a-z0-9]+:\/\//i.test(target) ? target : `${scheme}://${target}`;
  if (!parts.some((p) => p.includes("="))) return withScheme(parts[0]!, "http");
  const by = new Map(parts.map((p) => [p.slice(0, p.indexOf("=")).toLowerCase(), p.slice(p.indexOf("=") + 1)]));
  if (by.get("https")) return withScheme(by.get("https")!, "http");
  if (by.get("http")) return withScheme(by.get("http")!, "http");
  if (by.get("socks")) return withScheme(by.get("socks")!, "socks4");
  return undefined;
}

/** The proxy in `reg query "HKCU\...\Internet Settings"` output, or undefined when none is on. */
export function parseWindowsInternetSettings(text: string): SystemProxy | undefined {
  // Without /s, reg lists the key's own values, then its subkeys by name only.
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^ {4}(.+?) {4}(REG_\w+)(?: {4}(.*))?$/.exec(line);
    if (m && !values.has(m[1]!)) values.set(m[1]!, m[3] ?? "");
  }
  const enabled = /^0x0*1$/i.test(values.get("ProxyEnable") ?? "");
  const server = enabled ? winInetServer(values.get("ProxyServer") ?? "") : undefined;
  const pac = values.get("AutoConfigURL") || undefined;
  if (!server && !pac) return undefined;
  const direct = (values.get("ProxyOverride") ?? "")
    .split(";")
    .map((h) => h.trim())
    .filter(Boolean);
  return {
    source: "Windows Internet Settings",
    ...(server ? { server } : {}),
    ...(pac ? { pac } : {}),
    ...(direct.length ? { direct } : {}),
  };
}

/** A GVariant value as gsettings prints it: `'text'`, `8080`, `true`, `['a', 'b']`. */
function gvariant(value: string): string | string[] {
  const v = value.trim();
  if (v.startsWith("[")) return [...v.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]!);
  if (v.startsWith("@as [")) return gvariant(v.slice(4));
  const q = /^'((?:[^'\\]|\\.)*)'$/.exec(v);
  return q ? q[1]! : v;
}

/** The proxy in `gsettings list-recursively org.gnome.system.proxy` output, or undefined when none is on. */
export function parseGnomeProxy(text: string): SystemProxy | undefined {
  const keys = new Map<string, string | string[]>();
  for (const line of text.split("\n")) {
    const m = /^org\.gnome\.system\.proxy(\.\w+)? (\S+) (.*)$/.exec(line.trim());
    if (m) keys.set(`${m[1]?.slice(1) ?? ""}/${m[2]}`, gvariant(m[3]!));
  }
  const str = (k: string) => {
    const v = keys.get(k);
    return typeof v === "string" ? v : "";
  };
  const mode = str("/mode");
  const direct = keys.get("/ignore-hosts");
  const extra = Array.isArray(direct) && direct.length ? { direct } : {};
  if (mode === "auto") {
    const pac = str("/autoconfig-url");
    return { source: "GNOME settings", ...(pac ? { pac } : { autoDetect: true }), ...extra };
  }
  if (mode !== "manual") return undefined;
  // A scheme's proxy is on when its host is set and its port is not 0 (the schema's own rule).
  const on = (s: string) => str(`${s}/host`) !== "" && str(`${s}/port`) !== "0";
  const server = on("https")
    ? hostPort("http", str("https/host"), str("https/port"))
    : on("http")
      ? hostPort("http", str("http/host"), str("http/port"))
      : on("socks")
        ? hostPort("socks5", str("socks/host"), str("socks/port"))
        : undefined;
  return server ? { source: "GNOME settings", server, ...extra } : undefined;
}

/** The proxy in the environment Chrome inherits on Linux, or undefined when none is set. */
export function proxyFromEnv(env: NodeJS.ProcessEnv): SystemProxy | undefined {
  const get = (name: string) => env[name] || env[name.toUpperCase()] || undefined;
  const pac = get("auto_proxy");
  const raw = get("https_proxy") ?? get("http_proxy") ?? get("all_proxy");
  let server: string | undefined;
  if (raw) {
    try {
      const url = new URL(/^[a-z0-9]+:\/\//i.test(raw) ? raw : `http://${raw}`);
      // Credentials in the variable stay out of every report.
      server = hostPort(url.protocol.replace(/:$/, "").replace(/^socks$/, "socks5"), url.hostname, url.port);
    } catch {
      server = undefined;
    }
  }
  if (!server && !pac) return undefined;
  const direct = (get("no_proxy") ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  return {
    source: "environment",
    ...(server ? { server } : {}),
    ...(pac ? { pac } : {}),
    ...(direct.length ? { direct } : {}),
  };
}

/** The desktops whose proxy settings Chrome reads through GSettings on Linux. */
const GNOME_DESKTOPS = /GNOME|Unity|Pantheon|Budgie|Cinnamon|MATE/i;

type Run = (file: string, args: string[]) => string | undefined;

const run: Run = (file, args) => {
  try {
    return execFileSync(file, args, { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return undefined;
  }
};

/** The system's proxy, or undefined when it sets none (or it cannot be read). */
export function systemProxy(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  exec: Run = run,
): SystemProxy | undefined {
  if (platform === "darwin") {
    const out = exec("/usr/sbin/scutil", ["--proxy"]);
    return out ? parseScutilProxy(out) : undefined;
  }
  if (platform === "win32") {
    const out = exec("reg", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"]);
    return out ? parseWindowsInternetSettings(out) : undefined;
  }
  if (GNOME_DESKTOPS.test(env.XDG_CURRENT_DESKTOP ?? "")) {
    const out = exec("gsettings", ["list-recursively", "org.gnome.system.proxy"]);
    if (out) return parseGnomeProxy(out);
  }
  return proxyFromEnv(env);
}
