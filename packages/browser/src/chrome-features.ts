/**
 * Chrome features Playwright turns off, and the one turno turns back on.
 *
 * Playwright starts Chrome with one `--disable-features=` list (its `chromiumSwitches`). Among
 * them is `ThirdPartyStoragePartitioning`, which every Chrome since 115 has on: a site embedded
 * in another site gets its own storage there (localStorage, IndexedDB, caches) instead of its
 * first-party storage. A page can tell the difference, and a person's Chrome never has it off,
 * so turno's Chrome engine drops Playwright's list and passes the same list without that one
 * feature. Chrome reads the last `--disable-features` it is given, so the list goes before the
 * user's own launch args: a `--disable-features` there still wins, as it did before.
 *
 * The list is a copy of Playwright's: `test/chrome-features.test.ts` reads the installed
 * patchright-core and fails when they drift apart after an update.
 */

/** The feature turno leaves on. */
export const KEPT_FEATURE = "ThirdPartyStoragePartitioning";

/** Playwright's `disabledFeatures` (patchright-core 1.64), in its order. */
export const PLAYWRIGHT_DISABLED_FEATURES: readonly string[] = Object.freeze([
  "AvoidUnnecessaryBeforeUnloadCheckSync",
  "DestroyProfileOnBrowserClose",
  "DialMediaRouteProvider",
  "GlobalMediaControls",
  "HttpsUpgrades",
  "LensOverlay",
  "PaintHolding",
  "ThirdPartyStoragePartitioning",
  "BlockOriginHeaderModificationOnRedirect",
  "AvoidCorsURLLoaderRestartOnRedirect",
  "Translate",
  "AutoDeElevate",
  "OptimizationHints",
  "NetworkTimeServiceQuerying",
  "AimEnabled",
  "msForceBrowserSignIn",
  "msEdgeUpdateLaunchServicesPreferredVersion",
]);

/**
 * The switches for a Chrome turno launches: Playwright's list to drop, and the one to pass, with
 * `extra` features turned off as well (the low-resource preset's, `tuning.ts`).
 */
export function storagePartitioningArgs(extra: readonly string[] = []): {
  ignoreDefaultArgs: string[];
  args: string[];
} {
  const features = [...PLAYWRIGHT_DISABLED_FEATURES.filter((f) => f !== KEPT_FEATURE), ...extra];
  return {
    ignoreDefaultArgs: [`--disable-features=${PLAYWRIGHT_DISABLED_FEATURES.join(",")}`],
    args: [`--disable-features=${[...new Set(features)].join(",")}`],
  };
}
