import { describe, expect, it } from "vitest";
import * as pkg from "../src/index.js";
import { API_VERSION, SESSION_META_KEY, api } from "../src/index.js";

/**
 * The public API object turno-cli drives. The CLI types it with `import type` and
 * checks `API_VERSION` when it loads the package, so this list is the contract: adding a member
 * raises the minor version, removing or changing one raises the major version.
 */
const MEMBERS = [
  "ENGINES",
  "addIdentity",
  "assertIdentityId",
  "checkIdentitySettings",
  "engineId",
  "formatBenchTable",
  "identityDir",
  "identityExists",
  "identitySettingsPath",
  "inUseBy",
  "isInUse",
  "listIdentities",
  "loginIdentity",
  "manifestSnippet",
  "readHealth",
  "removeIdentity",
  "reputationReport",
  "runBench",
  "runDoctor",
  "writeIdentitySettings",
  // 1.1: the credential vault.
  "parseTotpSecret",
  "vaultAdd",
  "vaultClear",
  "vaultList",
  "vaultRemove",
  "vaultSetSubmit",
  // 1.2: session export and import.
  "exportSession",
  "importSession",
  "readSessionExport",
  // 1.6: saved flows, replay and recordings.
  "flowsDir",
  "listFlows",
  "listRecordings",
  "openTraceViewer",
  "readFlow",
  "recordingsDir",
  "removeFlow",
  "replayFlow",
  "traceViewerCommand",
  // 1.9: the live view of a running server.
  "liveLink",
  "livePause",
  "liveResume",
  "liveStatus",
  // 1.11: the background server of an identity.
  "backgroundStatus",
  "openBackgroundSession",
  "startBackground",
  "stopBackground",
  // 1.12: the identity commands themselves.
  "cli",
  // 1.13: the last sign-in by hand.
  "profileHasCookies",
  "readLoginRecord",
  // 1.14: the browser of an identity.
  "browserLabel",
  "browserSwitchProblem",
  "detectBrowsers",
  "installBrowser",
  "profileLastVersion",
  // 1.15: teach mode of a running server.
  "liveTeach",
];

describe("the public API object", () => {
  // 1.3: writeIdentitySettings accepts the humanize key (no new member).
  // 1.4: the sharing key and manifestSnippet(id, { sharing }) (no new member).
  // 1.5: the engine and attach keys and the engine checks of runDoctor (no new member).
  // 1.6: the record key, saved flows, replay and recordings.
  // 1.7: the act and captcha keys, and solved captchas in the reputation report.
  // 1.8: the tabLocks key and runDoctor({ servers }) (no new member).
  // 1.9: the live key and the live view of a running server.
  // 1.10: the userAgent and proxy keys and the camoufox engine (no new member).
  // 1.11: the background server of an identity.
  // 1.12: cli, the identity commands that turno-cli runs with its own host.
  // 1.13: readLoginRecord, and the sites loginIdentity returns.
  // 1.14: the browser key, browser detection and install-browser.
  // 1.15: liveTeach, teach mode of a running server.
  it("is version 1.15, frozen, with integer parts", () => {
    expect(API_VERSION).toEqual({ major: 1, minor: 15 });
    expect(Object.isFrozen(API_VERSION)).toBe(true);
    expect(Number.isInteger(API_VERSION.major) && Number.isInteger(API_VERSION.minor)).toBe(true);
  });

  it("has exactly the members of this API version, each the package's own export", () => {
    expect(Object.keys(api).sort()).toEqual([...MEMBERS].sort());
    expect(Object.isFrozen(api)).toBe(true);
    const named = pkg as unknown as Record<string, unknown>;
    for (const key of MEMBERS) expect(api[key as keyof typeof api], key).toBe(named[key]);
  });

  it("names the _meta key mcpd puts the client session in", () => {
    expect(SESSION_META_KEY).toBe("io.turno/session");
  });
});
