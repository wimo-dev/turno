import { execFileSync } from "node:child_process";

/**
 * The screen and window a headless Chrome reports, so a page sees what the same Chrome shows in
 * a window on this computer instead of Playwright's 1280x720 viewport on an 800x600 screen.
 *
 * Without a viewport, Playwright leaves the page the size of Chrome's own window, and headless
 * Chrome lays that window out like a windowed one: `--screen-info` gives it a screen (physical
 * pixels, a device pixel ratio, the work area left by the menu bar and the dock) and
 * `--window-size` a window in that screen, with the toolbar height a windowed Chrome has between
 * `outerHeight` and `innerHeight`. Screen, window, viewport and `devicePixelRatio` then agree with
 * each other, and nothing is emulated through the DevTools protocol.
 *
 * Measured with Chrome 158 on macOS: a windowed Chrome on a new profile opens a 1200x852 window
 * on a 1512x982 screen whose work area is 1512x896, 22 px in from its top left corner; headless
 * Chrome with the same screen and window size reports the same screen, window, inner size and
 * position.
 */

export interface Display {
  /** CSS pixels. */
  width: number;
  height: number;
  /** The menu bar or panels at the top and the dock or taskbar at the bottom, in CSS pixels. */
  workAreaTop: number;
  workAreaBottom: number;
  devicePixelRatio: number;
  /** Bits per pixel, as `screen.colorDepth` reports it. */
  colorDepth: number;
}

/** The most common desktop screen, for a computer whose screen cannot be read (no display at all). */
const FALLBACK_DISPLAY: Display = {
  width: 1920,
  height: 1080,
  workAreaTop: 0,
  workAreaBottom: 0,
  devicePixelRatio: 1,
  colorDepth: 24,
};

/** Chrome's default window: this far in from the work area's corner, and at most this wide. */
const WINDOW_INSET = 22;
const MAX_WINDOW_WIDTH = 1200;

/** The primary display of macOS from AppKit: frame, visible frame, scale and gamut. */
const MAC_SCRIPT = `ObjC.import("AppKit");
const s = $.NSScreen.screens.js[0];
JSON.stringify({
  width: s.frame.size.width,
  height: s.frame.size.height,
  visibleY: s.visibleFrame.origin.y - s.frame.origin.y,
  visibleHeight: s.visibleFrame.size.height,
  scale: s.backingScaleFactor,
  wide: s.canRepresentDisplayGamut(2),
});`;

/** Parses what MAC_SCRIPT prints; undefined when it is not a usable screen. */
function parseMacDisplay(text: string): Display | undefined {
  try {
    const s = JSON.parse(text) as Record<string, unknown>;
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
    const width = n(s.width);
    const height = n(s.height);
    const scale = n(s.scale) ?? 1;
    if (!width || !height || width < 640 || height < 480) return undefined;
    const bottom = Math.max(0, Math.round(n(s.visibleY) ?? 0));
    const visible = n(s.visibleHeight) ?? height;
    const top = Math.max(0, Math.round(height - visible - bottom));
    // Chrome reports 30 bits for a display that shows the P3 gamut, 24 for the others.
    return {
      width: Math.round(width),
      height: Math.round(height),
      workAreaTop: top,
      workAreaBottom: bottom,
      devicePixelRatio: scale,
      colorDepth: s.wide === true ? 30 : 24,
    };
  } catch {
    return undefined;
  }
}

/** The primary output of `xrandr --current`, or the first connected one. */
function parseXrandr(text: string): Display | undefined {
  const lines = text.split("\n").filter((l) => / connected /.test(l));
  const line = lines.find((l) => / connected primary /.test(l)) ?? lines[0];
  const m = line ? /(\d+)x(\d+)\+\d+\+\d+/.exec(line) : null;
  if (!m) return undefined;
  const width = Number(m[1]);
  const height = Number(m[2]);
  if (width < 640 || height < 480) return undefined;
  return { ...FALLBACK_DISPLAY, width, height };
}

function readDisplay(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): Display | undefined {
  const run = (cmd: string, args: string[]) =>
    execFileSync(cmd, args, { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"], env });
  try {
    if (platform === "darwin")
      return parseMacDisplay(run("/usr/bin/osascript", ["-l", "JavaScript", "-e", MAC_SCRIPT]));
    if (platform === "linux" && env.DISPLAY) return parseXrandr(run("xrandr", ["--current"]));
  } catch {
    return undefined;
  }
  return undefined;
}

let cached: Display | undefined;

/** The primary display, read once per process; the fallback when it cannot be read. */
export function primaryDisplay(platform: NodeJS.Platform = process.platform, env = process.env): Display {
  cached ??= readDisplay(platform, env) ?? FALLBACK_DISPLAY;
  return cached;
}

/** The size Chrome gives a new window on this display: the work area less its inset, at most 1200 wide. */
function defaultWindow(d: Display): { width: number; height: number } {
  const workHeight = d.height - d.workAreaTop - d.workAreaBottom;
  return {
    width: Math.max(800, Math.min(d.width - 2 * WINDOW_INSET, MAX_WINDOW_WIDTH)),
    height: Math.max(600, workHeight - 2 * WINDOW_INSET),
  };
}

/**
 * The switches that give a headless Chrome this display and its default window. `--screen-info`
 * takes physical pixels, so the CSS sizes are scaled by the pixel ratio.
 */
export function headlessDisplayArgs(d: Display): string[] {
  const px = (v: number) => Math.round(v * d.devicePixelRatio);
  const screen = [
    `${px(d.width)}x${px(d.height)}`,
    `devicePixelRatio=${d.devicePixelRatio}`,
    `colorDepth=${d.colorDepth}`,
    `workAreaTop=${px(d.workAreaTop)}`,
    `workAreaBottom=${px(d.workAreaBottom)}`,
  ].join(" ");
  const w = defaultWindow(d);
  return [`--screen-info={${screen}}`, `--window-size=${w.width},${w.height}`];
}
