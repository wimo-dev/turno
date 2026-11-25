import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  parseGnomeProxy,
  parseScutilProxy,
  parseWindowsInternetSettings,
  proxyFromEnv,
  systemProxy,
} from "../src/system-proxy.js";

/**
 * The system proxy, read as Chrome reads it, from the commands' real output: `scutil --proxy`
 * on macOS (one with no proxy, as macOS prints it with only the default exceptions), the
 * Internet Settings key `reg query` prints on Windows, `gsettings list-recursively` on GNOME.
 */

const fixture = (name: string) => readFileSync(new URL(`./fixtures/system-proxy/${name}`, import.meta.url), "utf8");

describe("macOS (scutil --proxy)", () => {
  it("reads no proxy from the default settings, only exceptions", () => {
    expect(parseScutilProxy(fixture("macos-none.txt"))).toBeUndefined();
  });

  it("prefers the HTTPS proxy, keeps the exceptions, and skips the per-interface dictionaries", () => {
    expect(parseScutilProxy(fixture("macos-manual.txt"))).toEqual({
      source: "macOS network settings",
      server: "http://proxy.example.com:8443",
      direct: ["*.local", "169.254/16"],
    });
  });

  it("reports a PAC file and auto discovery without resolving them", () => {
    expect(parseScutilProxy(fixture("macos-pac.txt"))).toEqual({
      source: "macOS network settings",
      pac: "http://wpad/wpad.dat",
      autoDetect: true,
      direct: ["localhost", "127.0.0.1"],
    });
  });
});

describe("Windows (Internet Settings)", () => {
  it("reads a per-scheme ProxyServer when ProxyEnable is 1", () => {
    expect(parseWindowsInternetSettings(fixture("windows-manual.txt"))).toEqual({
      source: "Windows Internet Settings",
      server: "http://secure.example.com:8443",
      direct: ["*.example.com", "<local>"],
    });
  });

  it("ignores ProxyServer when ProxyEnable is 0 and reports AutoConfigURL", () => {
    expect(parseWindowsInternetSettings(fixture("windows-pac.txt"))).toEqual({
      source: "Windows Internet Settings",
      pac: "http://wpad.example.com/proxy.pac",
    });
  });

  it("takes a single host:port as an http proxy", () => {
    const one = fixture("windows-manual.txt").replace(/http=\S+/, "proxy.example.com:3128");
    expect(parseWindowsInternetSettings(one)?.server).toBe("http://proxy.example.com:3128");
  });
});

describe("Linux", () => {
  it("reads GNOME's manual mode, and nothing when the mode is none", () => {
    expect(parseGnomeProxy(fixture("gnome-manual.txt"))).toEqual({
      source: "GNOME settings",
      server: "http://172.31.102.29:3128",
      direct: ["localhost", "127.0.0.0/8", "::1"],
    });
    expect(parseGnomeProxy(fixture("gnome-none.txt"))).toBeUndefined();
  });

  it("reads the environment elsewhere, never with its credentials", () => {
    expect(
      proxyFromEnv({ HTTPS_PROXY: "http://alice:secret@proxy.example.com:3128", no_proxy: "localhost,.internal" }),
    ).toEqual({ source: "environment", server: "http://proxy.example.com:3128", direct: ["localhost", ".internal"] });
    expect(proxyFromEnv({})).toBeUndefined();
  });

  it("asks gsettings only on a GNOME desktop", () => {
    const calls: string[] = [];
    const exec = (file: string) => {
      calls.push(file);
      return fixture("gnome-manual.txt");
    };
    expect(systemProxy("linux", { XDG_CURRENT_DESKTOP: "ubuntu:GNOME" }, exec)?.source).toBe("GNOME settings");
    expect(systemProxy("linux", { XDG_CURRENT_DESKTOP: "KDE", http_proxy: "proxy.example.com:8080" }, exec)).toEqual({
      source: "environment",
      server: "http://proxy.example.com:8080",
    });
    expect(calls).toEqual(["gsettings"]);
  });
});
