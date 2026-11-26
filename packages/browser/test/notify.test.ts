import { describe, expect, it } from "vitest";
import { type NotifyCommand, Notifier, RunWatch, notifyCommand } from "../src/notify.js";
import { Redactor } from "../src/redact.js";

/** The system's notifications: never a secret value, never text a shell reads, never twice. */

const SECRET = "hunter2-Vault-Value";

describe("Notifier", () => {
  it("never carries a vault value or a password, on any system", () => {
    const redactor = new Redactor();
    redactor.add(SECRET, "bank");
    redactor.addField("typed-p4ss", "[sensitive field]");
    for (const platform of ["darwin", "linux", "win32"] as const) {
      const sent: NotifyCommand[] = [];
      const notifier = new Notifier({
        enabled: true,
        redactor,
        platform,
        env: { PATH: "/usr/bin", SystemRoot: "C:\\Windows" },
        exists: (path) => path === "/usr/bin/notify-send",
        run: (cmd) => sent.push(cmd),
      });
      notifier.send({
        title: `turno · bank: your turn`,
        body: `Sign in as ${SECRET} with typed-p4ss "now"; $(rm -rf ~) <b>`,
      });
      const all = JSON.stringify(sent);
      expect(all, platform).not.toContain(SECRET);
      expect(all, platform).not.toContain("typed-p4ss");
      expect(all, platform).toContain("[vault: bank]");
    }
  });

  it("passes the text as arguments or environment, never as script", () => {
    const n = { title: 'a "b" c', body: 'x\'; do shell script "id"' };
    const mac = notifyCommand(n, "darwin")!;
    expect(mac.args.slice(-2)).toEqual([n.title, n.body]);
    expect(mac.args.slice(0, -2).join(" ")).not.toContain("shell");
    const win = notifyCommand(n, "win32", { SystemRoot: "C:\\Windows" })!;
    expect(win.args.join(" ")).not.toContain(n.body);
    expect(win.env).toMatchObject({ TOAST_TITLE: n.title, TOAST_BODY: n.body });
    const linux = notifyCommand(
      { title: "-t", body: "<i>x</i> & y" },
      "linux",
      { PATH: "/usr/bin" },
      (p) => p === "/usr/bin/notify-send",
    )!;
    expect(linux.args).toEqual(["--app-name=turno", "--", "-t", "&lt;i&gt;x&lt;/i&gt; &amp; y"]);
    expect(notifyCommand(n, "linux", { PATH: "/usr/bin" }, () => false)).toBeUndefined();
  });

  it("shows nothing when off, and the same notice once a minute", () => {
    let now = 0;
    const sent: NotifyCommand[] = [];
    const on = new Notifier({
      enabled: true,
      redactor: new Redactor(),
      platform: "darwin",
      run: (c) => sent.push(c),
      now: () => now,
    });
    on.send({ title: "t", body: "b" });
    on.send({ title: "t", body: "b" });
    now = 61_000;
    on.send({ title: "t", body: "b" });
    expect(sent).toHaveLength(2);
    const off = new Notifier({
      enabled: false,
      redactor: new Redactor(),
      platform: "darwin",
      run: (c) => sent.push(c),
    });
    off.send({ title: "t", body: "other" });
    expect(sent).toHaveLength(2);
  });
});

describe("RunWatch", () => {
  it("tells only the end of a long run, after the agent stops", async () => {
    let now = 0;
    const done: [number, number][] = [];
    const runs = new RunWatch((steps, ms) => done.push([steps, ms]), { longMs: 1_000, idleMs: 20, now: () => now });
    runs.call();
    now = 500;
    runs.call();
    await new Promise((r) => setTimeout(r, 40));
    expect(done).toEqual([]); // 0.5 s: too short to tell
    now = 1_000;
    runs.call();
    now = 2_200;
    runs.call();
    await new Promise((r) => setTimeout(r, 40));
    expect(done).toEqual([[2, 1_200]]);
    runs.dispose();
  });
});
