import { fileURLToPath } from "node:url";

export { API_VERSION, type ApiVersion, type BrowserApi, type BrowserFunctions, api } from "./api.js";
export { type BrowserCli, browserCli as cli } from "./cli/commands.js";
export type { BrowserCliHost, CliDeps, CliNames, OpenUrl, VaultInput } from "./cli/context.js";
export type { DoSession, DoSessionInfo, DoTarget, DoTransport, ToolResult } from "./cli/do.js";
export { CLIENT_META_KEY, SESSION_CAPABILITY, SESSION_ENDED_METHOD, SESSION_META_KEY } from "./session.js";
export { manifestSnippet } from "./snippet.js";
export {
  IdentityError,
  type IdentityInfo,
  addIdentity,
  assertIdentityId,
  identityDir,
  identityExists,
  identityStateDir,
  inUseBy,
  isInUse,
  isValidIdentityId,
  listIdentities,
  parseSingletonLock,
  removeIdentity,
} from "./identities.js";
export {
  type HealthCheck,
  IDENTITY_FORMAT_VERSION,
  type IdentitySettings,
  type LiveSettings,
  type RecordSettings,
  type SettingsPatch,
  type TabLockSettings,
  checkIdentitySettings,
  identitySettingsPath,
  readIdentitySettings,
  systemTimezone,
  writeIdentitySettings,
} from "./settings.js";
export {
  IdentityInUseError,
  type RuntimeLock,
  readRuntimeLock,
  runtimeLockAlive,
  runtimeLockPath,
} from "./runtime-lock.js";
export { type HealthRecord, readHealth } from "./health.js";
export {
  type ChallengeEvent,
  type IdentityReputation,
  type SiteSummary,
  readChallenges,
  reputationReport,
} from "./reputation.js";
export {
  type ChromeInfo,
  type DoctorCheck,
  type DoctorOptions,
  type DoctorReport,
  type ServedIdentity,
  findChrome,
  runDoctor,
} from "./doctor.js";
export { type BuiltArgv, type PlaywrightMcpConfig, buildArgv, extractIdentity } from "./argv.js";
export {
  BROWSER_IDS,
  type BrowserChoice,
  type BrowserId,
  type DetectedBrowser,
  browserLabel,
  browserSwitchProblem,
  detectBrowsers,
  profileLastVersion,
} from "./browsers.js";
export { type InstallBrowserOptions, type InstallBrowserResult, installBrowser } from "./install-browser.js";
export {
  type BenchOptions,
  type BenchReport,
  DETECTORS,
  ENGINES,
  ENGINE_ALIASES,
  type EngineName,
  type EngineReport,
  type TargetResult,
  defaultEngines,
  engineId,
  formatBenchTable,
  runBench,
  unavailableReason,
} from "./bench.js";
export {
  CHALLENGE_MARKERS,
  type ChallengeKind,
  classifyChallenge,
  detectChallenge,
  parseRebrowser,
  parseSannysoft,
} from "./detectors.js";
export {
  type LoginOptions,
  type LoginRecord,
  type LoginResult,
  loginIdentity,
  profileHasCookies,
  readLoginRecord,
} from "./login.js";
export { LiveError, liveLink, livePause, liveResume, liveStatus, liveTeach } from "./live-client.js";
export {
  BackgroundError,
  type BackgroundSession,
  type BackgroundState,
  type CallOptions,
  type OpenSessionOptions,
  type StartBackgroundOptions,
  type StartedBackground,
  backgroundStatus,
  openBackgroundSession,
  startBackground,
  stopBackground,
} from "./client.js";
export type { LiveStatus } from "./live-server.js";
export { type TotpParams, TotpError, parseTotpSecret, totp } from "./totp.js";
export { SealError } from "./sealed.js";
export {
  type ExportOptions,
  type ImportOptions,
  type SessionSummary,
  exportSession,
  importSession,
  readSessionExport,
} from "./session-export.js";
export {
  type SubmitPolicy,
  type VaultAddInput,
  VaultError,
  type VaultInfo,
  type VaultSite,
  vaultAdd,
  vaultClear,
  vaultList,
  vaultPath,
  vaultRemove,
  vaultSetSubmit,
} from "./vault.js";
export {
  type Flow,
  FlowError,
  type FlowLocator,
  type FlowParam,
  type FlowStep,
  type FlowSummary,
  type FlowTarget,
  type ParamRef,
  flowsDir,
  listFlows,
  readFlow,
  removeFlow,
} from "./flows.js";
export { type ReplayOptions, replayFlow } from "./replay.js";
export {
  type RecordingSummary,
  listRecordings,
  openTraceViewer,
  recordingsDir,
  traceViewerCommand,
} from "./recordings.js";
export { mcpEntryPath } from "./patchright.js";
export { browserPaths as paths } from "turno-core/paths";

/** Absolute path of the `turno-browser-mcp` executable script of this install. */
export function mcpBinPath(): string {
  return fileURLToPath(new URL("./bin/mcp.js", import.meta.url));
}
