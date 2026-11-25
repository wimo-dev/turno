import { describe, expect, it } from "vitest";
import { type AppWindowProbe, appWindowCommand } from "../../src/cli/app-window.js";

/** Which browser `live` opens the view in as an app window, from what the system says. */

const URL = "http://127.0.0.1:4321/?code=one-time";

function probe(platform: NodeJS.Platform, files: string[], out: Record<string, string> = {}): AppWindowProbe {
  return {
    platform,
    env: { HOME: "/Users/alice", PATH: "/usr/bin:/opt/bin" },
    exists: (path) => files.includes(path),
    run: (command, args) => out[[command, ...args].join(" ")],
  };
}

const PLIST = "/Users/alice/Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist";
const plutil = (bundle: string) => ({
  [`/usr/bin/plutil -convert json -o - ${PLIST}`]: JSON.stringify({
    LSHandlers: [{ LSHandlerURLScheme: "https", LSHandlerRoleAll: bundle }],
  }),
});

describe("appWindowCommand", () => {
  it("uses the default browser when it is a Chromium one, else Google Chrome, else none", () => {
    expect(appWindowCommand(URL, probe("darwin", [PLIST], plutil("com.brave.Browser")))).toEqual({
      command: "open",
      args: ["-n", "-b", "com.brave.browser", "--args", `--app=${URL}`],
      browser: "Brave Browser",
    });
    const chrome = ["/Applications/Google Chrome.app", PLIST];
    expect(appWindowCommand(URL, probe("darwin", chrome, plutil("com.apple.Safari")))?.browser).toBe("Google Chrome");
    expect(appWindowCommand(URL, probe("darwin", [PLIST], plutil("org.mozilla.firefox")))).toBeUndefined();

    const linux = probe("linux", ["/opt/bin/brave-browser", "/usr/bin/google-chrome"], {
      "xdg-settings get default-web-browser": "brave-browser.desktop\n",
    });
    expect(appWindowCommand(URL, linux)).toEqual({
      command: "/opt/bin/brave-browser",
      args: [`--app=${URL}`],
      browser: "brave-browser",
    });
    expect(appWindowCommand(URL, probe("linux", ["/usr/bin/chromium"]))?.command).toBe("/usr/bin/chromium");
    expect(appWindowCommand(URL, probe("linux", []))).toBeUndefined();
  });
});
