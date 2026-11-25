import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { connect as netConnect, type Socket } from "node:net";
import { join } from "node:path";
import { connect as tlsConnect } from "node:tls";
import { replaceFileSync } from "turno-core/paths";
import { identityStateDir } from "./ids.js";

/**
 * Where a proxy's traffic leaves, checked against what the identity presents. With a proxy in
 * use (the identity's, the server's or the system's), a site sees the proxy's exit address, and a
 * time zone or locale from another country next to it is a mismatch a site can see. turno asks
 * one service for the exit's country and time zone, through the proxy itself, and warns when the
 * identity's time zone or locale's region differs.
 *
 * The lookup is one HTTPS GET to `GEO_ENDPOINT` (GeoJS: no key, no cookies, no access logs by its
 * privacy policy) with no cookie, no identity name and no header but Host and a generic user
 * agent; only the country and the time zone are kept, in the identity's state folder, for a day
 * per proxy. `TURNO_BROWSER_EXIT_CHECK=0` turns it off. A local GeoIP database was not used: the
 * free ones need an account key or weigh tens of megabytes and go stale within a month.
 */

const GEO_ENDPOINT = "https://get.geojs.io/v1/ip/geo.json";

/** How long a lookup is kept per proxy. */
const TTL_MS = 24 * 60 * 60 * 1000;

const FILE = "exit-geo.json";

/** What the lookup keeps: never the address itself. */
export interface ExitGeo {
  /** The proxy it went through, as `scheme://host:port`. */
  proxy: string;
  /** ISO 3166 two-letter country of the exit address. */
  country: string;
  /** The IANA time zone of the exit address. */
  timezone: string;
  checkedAt: number;
}

/** A proxy to look up through: Playwright's launch option shape. */
export interface ExitProxy {
  server: string;
  username?: string;
  password?: string;
}

/** True when the person turned the lookup off. */
function exitCheckOff(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.TURNO_BROWSER_EXIT_CHECK?.trim().toLowerCase();
  return v === "0" || v === "off" || v === "false" || v === "no";
}

function validZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The country and time zone in the service's reply, or why it is not one. */
export function parseGeo(body: string): { country: string; timezone: string } | { error: string } {
  let data: { country_code?: unknown; timezone?: unknown };
  try {
    data = JSON.parse(body) as typeof data;
  } catch {
    return { error: "the lookup did not answer JSON" };
  }
  const country = typeof data.country_code === "string" ? data.country_code.toUpperCase() : "";
  const timezone = typeof data.timezone === "string" ? data.timezone : "";
  if (!/^[A-Z]{2}$/.test(country) || !validZone(timezone))
    return { error: "the lookup answered no country or time zone" };
  return { country, timezone };
}

/** The UTC offset of a zone now, in minutes. */
function offsetMinutes(tz: string, at: Date): number | undefined {
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" })
      .formatToParts(at)
      .find((p) => p.type === "timeZoneName")?.value;
    const m = /GMT(?:([+-])(\d{2}):(\d{2}))?/.exec(part ?? "");
    if (!m) return undefined;
    return m[1] ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
  } catch {
    return undefined;
  }
}

/** The locale most people in `country` use (CLDR likely subtags): `MX` is `es-MX`. */
export function likelyLocale(country: string): string | undefined {
  try {
    const l = new Intl.Locale(`und-${country}`).maximize();
    return l.language && l.language !== "und" ? `${l.language}-${country}` : undefined;
  } catch {
    return undefined;
  }
}

/** The region a locale implies: its own, else the likeliest (`es` is `ES`). */
function regionOf(locale: string): string | undefined {
  try {
    return new Intl.Locale(locale).maximize().region;
  } catch {
    return undefined;
  }
}

/** What the identity presents: its time zone and the locale its pages read. */
export interface Presented {
  timezone: string;
  locale?: string;
}

/**
 * The mismatches between the exit address and what the identity presents: a time zone whose
 * offset differs now (zones of the same offset, `America/Monterrey` and `America/Mexico_City`,
 * agree), and a locale whose region is another country. Empty when they agree.
 */
export function geoProblems(
  geo: Pick<ExitGeo, "country" | "timezone">,
  presented: Presented,
  at = new Date(),
): string[] {
  const out: string[] = [];
  const exit = offsetMinutes(geo.timezone, at);
  const mine = offsetMinutes(presented.timezone, at);
  if (exit !== undefined && mine !== undefined && exit !== mine)
    out.push(
      `the proxy exits in ${geo.country} (${geo.timezone}), but the identity's time zone is ${presented.timezone}: set --timezone ${geo.timezone}`,
    );
  const region = presented.locale ? regionOf(presented.locale) : undefined;
  if (presented.locale && region && region !== geo.country) {
    const likely = likelyLocale(geo.country);
    out.push(
      `the proxy exits in ${geo.country}, but the identity's locale is ${presented.locale}${likely ? `: ${likely} would match it` : ""}`,
    );
  }
  return out;
}

/** The proxy as the cache keys it, without credentials. */
function proxyKey(server: string): string {
  try {
    const u = new URL(server);
    return `${u.protocol}//${u.host}`;
  } catch {
    return server;
  }
}

/** The last lookup for this identity, when it went through `proxy` and is less than a day old. */
function readExitGeo(id: string, env: NodeJS.ProcessEnv, proxy?: string, now = Date.now()): ExitGeo | undefined {
  const file = join(identityStateDir(id, env), FILE);
  if (!existsSync(file)) return undefined;
  try {
    const geo = JSON.parse(readFileSync(file, "utf8")) as ExitGeo;
    if (proxy !== undefined && geo.proxy !== proxyKey(proxy)) return undefined;
    if (now - geo.checkedAt > TTL_MS) return undefined;
    return geo;
  } catch {
    return undefined;
  }
}

function writeExitGeo(id: string, env: NodeJS.ProcessEnv, geo: ExitGeo): void {
  const dir = identityStateDir(id, env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(geo, null, 2)}\n`, { mode: 0o600 });
  replaceFileSync(tmp, file);
}

/** Reads from a socket until `done` says the bytes so far are enough. */
function readUntil(socket: Socket, done: (data: Buffer) => number | undefined): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let data = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      data = Buffer.concat([data, chunk]);
      const n = done(data);
      if (n === undefined) return;
      cleanup();
      if (n < data.length) socket.unshift(data.subarray(n));
      resolve(data.subarray(0, n));
    };
    const onEnd = () => {
      cleanup();
      reject(new Error("the proxy closed the connection"));
    };
    const onError = (e: Error) => {
      cleanup();
      reject(e);
    };
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("end", onEnd);
      socket.off("error", onError);
    };
    socket.on("data", onData);
    socket.once("end", onEnd);
    socket.once("error", onError);
  });
}

/** A raw TCP connection to `host:port` through the proxy (HTTP CONNECT, SOCKS4a or SOCKS5). */
async function tunnel(proxy: ExitProxy, host: string, port: number): Promise<Socket> {
  const url = new URL(proxy.server);
  const scheme = url.protocol.replace(/:$/, "");
  const defaultPort = scheme === "https" ? 443 : scheme === "http" ? 80 : 1080;
  const proxyPort = Number(url.port || defaultPort);
  const socket: Socket =
    scheme === "https"
      ? tlsConnect({ host: url.hostname, port: proxyPort, servername: url.hostname })
      : netConnect({ host: url.hostname, port: proxyPort });
  await new Promise<void>((resolve, reject) => {
    socket.once(scheme === "https" ? "secureConnect" : "connect", () => resolve());
    socket.once("error", reject);
  });
  if (scheme === "http" || scheme === "https") {
    const auth =
      proxy.username !== undefined && proxy.password !== undefined
        ? `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString("base64")}\r\n`
        : "";
    socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth}\r\n`);
    const head = await readUntil(socket, (d) => {
      const i = d.indexOf("\r\n\r\n");
      return i < 0 ? undefined : i + 4;
    });
    const status = /^HTTP\/1\.[01] (\d{3})/.exec(head.toString("latin1"))?.[1];
    if (status !== "200") throw new Error(`the proxy answered ${status ?? "something else"} to CONNECT`);
    return socket;
  }
  if (scheme === "socks5") {
    socket.write(Buffer.from([5, 1, 0]));
    const hello = await readUntil(socket, (d) => (d.length >= 2 ? 2 : undefined));
    if (hello[0] !== 5 || hello[1] !== 0) throw new Error("the SOCKS5 proxy wants a sign-in");
    const name = Buffer.from(host);
    socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, Buffer.from([port >> 8, port & 255])]));
    const reply = await readUntil(socket, (d) => {
      if (d.length < 5) return undefined;
      const len = d[3] === 1 ? 4 : d[3] === 4 ? 16 : d[3] === 3 ? 1 + d[4]! : 0;
      return d.length >= 4 + len + 2 ? 4 + len + 2 : undefined;
    });
    if (reply[1] !== 0) throw new Error(`the SOCKS5 proxy refused the connection (${reply[1]})`);
    return socket;
  }
  if (scheme === "socks4") {
    socket.write(
      Buffer.concat([Buffer.from([4, 1, port >> 8, port & 255, 0, 0, 0, 1, 0]), Buffer.from(host), Buffer.from([0])]),
    );
    const reply = await readUntil(socket, (d) => (d.length >= 8 ? 8 : undefined));
    if (reply[1] !== 0x5a) throw new Error("the SOCKS4 proxy refused the connection");
    return socket;
  }
  socket.destroy();
  throw new Error(`a ${scheme} proxy cannot be checked`);
}

/**
 * The exit's country and time zone, asked of `GEO_ENDPOINT` through the proxy. The request
 * carries nothing but the endpoint's host and a generic user agent.
 */
export async function lookupExit(
  proxy: ExitProxy,
  timeoutMs = 5000,
  endpoint = GEO_ENDPOINT,
): Promise<{ country: string; timezone: string }> {
  const target = new URL(endpoint);
  let raw: Socket | undefined;
  const work = (async () => {
    raw = await tunnel(proxy, target.hostname, Number(target.port || 443));
    const tls = tlsConnect({ socket: raw, servername: target.hostname });
    await new Promise<void>((resolve, reject) => {
      tls.once("secureConnect", () => resolve());
      tls.once("error", reject);
    });
    // HTTP/1.0: one plain body, closed at the end, never chunked.
    tls.write(
      `GET ${target.pathname}${target.search} HTTP/1.0\r\nHost: ${target.host}\r\nUser-Agent: turno-browser\r\nAccept: application/json\r\n\r\n`,
    );
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      tls.on("data", (c: Buffer) => chunks.push(c));
      tls.once("end", () => resolve());
      tls.once("close", () => resolve());
      tls.once("error", reject);
    });
    tls.destroy();
    const text = Buffer.concat(chunks).toString("utf8");
    const split = text.indexOf("\r\n\r\n");
    const status = /^HTTP\/1\.[01] (\d{3})/.exec(text)?.[1];
    if (status !== "200" || split < 0) throw new Error(`the lookup answered ${status ?? "nothing"}`);
    const geo = parseGeo(text.slice(split + 4));
    if ("error" in geo) throw new Error(geo.error);
    return geo;
  })();
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("the lookup took too long")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    (raw as Socket | undefined)?.destroy();
  }
}

/**
 * Looks the exit up (once a day per proxy) and returns the mismatches; nothing when the check is
 * off or the lookup fails (a failed lookup is not a mismatch). For the launch: it never throws.
 */
export async function checkExit(
  identity: { id: string; env: NodeJS.ProcessEnv },
  proxy: ExitProxy,
  presented: Presented,
  lookup: typeof lookupExit = lookupExit,
): Promise<string[]> {
  if (exitCheckOff(identity.env)) return [];
  try {
    let geo = readExitGeo(identity.id, identity.env, proxy.server);
    if (!geo) {
      const found = await lookup(proxy);
      geo = { proxy: proxyKey(proxy.server), ...found, checkedAt: Date.now() };
      writeExitGeo(identity.id, identity.env, geo);
    }
    return geoProblems(geo, presented);
  } catch {
    return [];
  }
}

/**
 * For `show`, `status` and `doctor`, without going online: the last lookup through `proxyServer`
 * and what in it does not match. Undefined when there is no recent lookup for that proxy.
 */
export function exitReport(
  id: string,
  env: NodeJS.ProcessEnv,
  proxyServer: string,
  presented: Presented,
): { geo: ExitGeo; problems: string[] } | undefined {
  const geo = readExitGeo(id, env, proxyServer);
  return geo ? { geo, problems: geoProblems(geo, presented) } : undefined;
}
