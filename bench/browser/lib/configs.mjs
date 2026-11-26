// Configurations the evaluation suite and the fingerprint bench compare. A configuration is
// data, not code: extra server flags, identity.json keys, extra environment, another build of
// the server, and what the fingerprint bench should then see. A capability that has not
// landed yet is one more entry here; until the server accepts its key or flag, runs of that
// configuration are reported as unsupported instead of failing.

import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

/**
 * @typedef {object} Config
 * @property {string} name kebab-case id used on the command line and in reports
 * @property {string} description one line for `--list`
 * @property {string[]} [args] extra `turno-browser-mcp` flags
 * @property {Record<string, unknown>} [identity] identity.json keys for the throwaway identity
 * @property {Record<string, string>} [env] extra environment for the server
 * @property {string} [bin] another build's `dist/bin/mcp.js` (a before and after of an update)
 * @property {boolean} [headed] run headed (true) or headless (false) whatever the run's flag says
 * @property {string} [needs] the capability the configuration needs, shown when the server lacks it
 * @property {Record<string, "pass" | "warn" | "info">} [expect] fingerprint checks that must reach
 *   at least this status with this configuration (a check below it fails the bench)
 */

/** @type {Config[]} */
export const BUILTIN = [
  { name: "default", description: "the server as installed, no identity.json keys" },
  { name: "headed", description: "a visible Chrome window (the default outside tests)", headed: true },
  {
    name: "cursor-in-page",
    description: 'identity.json "cursor": "on": the agent cursor drawn as elements in the page',
    identity: { cursor: "on" },
  },
  {
    name: "snapshot-full",
    description: "TURNO_BROWSER_SNAPSHOT=full: page snapshots as upstream writes them, not compacted",
    env: { TURNO_BROWSER_SNAPSHOT: "full" },
  },
  {
    name: "snapshot-compact",
    description: "TURNO_BROWSER_SNAPSHOT=compact: compact snapshots, no changes on an action's result",
    env: { TURNO_BROWSER_SNAPSHOT: "compact" },
  },
  { name: "settle-100", description: 'identity.json "settle": "100ms"', identity: { settle: "100ms" } },
  {
    name: "settle-0",
    description: 'identity.json "settle": "0" (no wait after an action: isolates what the wait costs)',
    identity: { settle: "0" },
  },
  {
    name: "block-heavy",
    description: "identity.json blocks images, media and fonts",
    identity: { block: { types: ["image", "media", "font"] } },
  },
  { name: "tabs-4", description: "identity.json caps open pages at 4", identity: { tabs: { max: 4 } } },
  {
    name: "humanize-light",
    description: "human-like input, light level",
    // A fixed seed makes the paths and delays the same in every run.
    identity: { humanize: { level: "light", seed: 1 } },
    needs: "human-like input levels (identity.json humanize)",
    expect: { "pointer-moves-before-click": "pass", "typing-key-events": "pass", "typing-interval": "pass" },
  },
  {
    name: "humanize-full",
    description: "human-like input, full level",
    identity: { humanize: { level: "full", seed: 1 } },
    needs: "human-like input levels (identity.json humanize)",
    expect: {
      "pointer-moves-before-click": "pass",
      "typing-key-events": "pass",
      "typing-interval": "pass",
      "press-duration": "pass",
      "scroll-steps": "pass",
    },
  },
  {
    name: "lightpanda",
    description: "read mode: Lightpanda as the engine (opt-in, needs lightpanda installed)",
    identity: { engine: "lightpanda" },
    needs: "read mode (identity.json engine) and lightpanda on PATH or TURNO_LIGHTPANDA_PATH",
  },
  {
    name: "camoufox",
    description: "Camoufox as the engine (opt-in, Firefox based, needs Camoufox and playwright-core)",
    identity: { engine: "camoufox" },
    needs: "the Camoufox engine (identity.json engine)",
    expect: { "headers-match-navigator": "pass", "worker-matches-page": "pass" },
  },
  {
    name: "user-agent-coherent",
    description: 'identity.json "userAgent": "coherent" (the installed Chrome\'s own user agent, checked at launch)',
    identity: { userAgent: "coherent" },
    needs: "identity.json userAgent",
    expect: {
      "headless-token": "pass",
      "client-hints-match": "pass",
      "headers-match-navigator": "pass",
      "worker-matches-page": "pass",
    },
  },
  {
    name: "user-agent-coherent-tz",
    description: "userAgent coherent with a time zone other than the computer's",
    identity: { userAgent: "coherent", timezone: "Pacific/Auckland" },
    needs: "identity.json userAgent",
    expect: {
      "headless-token": "pass",
      "client-hints-match": "pass",
      "headers-match-navigator": "pass",
      "worker-matches-page": "pass",
    },
  },
  {
    name: "timezone-other",
    description: "a time zone other than the computer's (identity.json timezone)",
    identity: { timezone: "Pacific/Auckland" },
    expect: { "worker-matches-page": "pass", "headers-match-navigator": "pass" },
  },
  {
    name: "locale-other",
    description: "a locale other than the computer's (identity.json locale)",
    identity: { locale: "fr-FR" },
    expect: { "worker-matches-page": "pass", "headers-match-navigator": "pass" },
  },
];

const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const KEYS = new Set(["name", "description", "args", "identity", "env", "bin", "headed", "needs", "expect"]);

/** Problems with one configuration entry, empty when it is valid. */
export function configProblems(c) {
  if (typeof c !== "object" || c === null || Array.isArray(c)) return ["must be an object"];
  const out = [];
  if (typeof c.name !== "string" || !NAME.test(c.name)) out.push("name must be kebab-case, like settle-100");
  for (const k of Object.keys(c)) if (!KEYS.has(k)) out.push(`unknown key "${k}"`);
  if (c.args !== undefined && (!Array.isArray(c.args) || c.args.some((a) => typeof a !== "string")))
    out.push("args must be a list of strings");
  for (const k of ["identity", "env", "expect"]) {
    if (c[k] !== undefined && (typeof c[k] !== "object" || c[k] === null || Array.isArray(c[k])))
      out.push(`${k} must be an object`);
  }
  if (c.env && Object.values(c.env).some((v) => typeof v !== "string")) out.push("env values must be strings");
  if (c.bin !== undefined && typeof c.bin !== "string") out.push("bin must be a path");
  if (c.headed !== undefined && typeof c.headed !== "boolean") out.push("headed must be true or false");
  return out;
}

/**
 * Reads a configurations file: a JSON list of entries, or `{ "configs": [...] }`. A relative
 * `bin` is relative to the file.
 */
export function readConfigsFile(file) {
  const raw = JSON.parse(readFileSync(file, "utf8"));
  const list = Array.isArray(raw) ? raw : raw?.configs;
  if (!Array.isArray(list)) throw new Error(`${file}: expected a list of configurations or { "configs": [...] }`);
  return list.map((c, i) => {
    const problems = configProblems(c);
    if (problems.length) throw new Error(`${file}: configuration ${i + 1}: ${problems.join("; ")}`);
    const out = { description: "from a configurations file", ...c };
    if (out.bin && !isAbsolute(out.bin)) out.bin = resolve(dirname(file), out.bin);
    return out;
  });
}

/** The configurations known to this run: built-ins, then a file's (a file entry replaces a built-in of the same name). */
export function knownConfigs(extra = []) {
  const byName = new Map(BUILTIN.map((c) => [c.name, c]));
  for (const c of extra) byName.set(c.name, c);
  return byName;
}

/** The configuration a name stands for; throws with the known names when there is none. */
export function resolveConfig(name, known) {
  const c = known.get(name);
  if (!c) throw new Error(`unknown configuration "${name}" (known: ${[...known.keys()].join(", ")})`);
  return c;
}

/** Whether a configuration runs headed, given the run's own `--headed`. */
export function isHeaded(config, headedFlag) {
  return config.headed ?? headedFlag;
}
