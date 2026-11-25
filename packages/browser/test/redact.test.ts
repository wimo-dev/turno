import { describe, expect, it } from "vitest";
import { recordingReason } from "../src/login-tool.js";
import { Redactor, variantsOf } from "../src/redact.js";

describe("the vault redactor", () => {
  it("hides a value as typed and as pages and tools encode it", () => {
    const r = new Redactor();
    const value = 'p@ss w0rd&"x"';
    r.add(value, "github password");
    const body = new URLSearchParams({ user: "a", pass: value }).toString();
    const text = [
      `textbox "Password": ${value}`,
      `POST /session ${body}`,
      `{"password":${JSON.stringify(value)}}`,
      `<input value="${value.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}">`,
      `GET /?p=${encodeURIComponent(value)}`,
    ].join("\n");
    const out = r.text(text);
    for (const v of variantsOf(value)) expect(out).not.toContain(v);
    expect(out.match(/\[vault: github password\]/g)?.length).toBe(5);
  });

  it("redacts every text part and structured content, and leaves images alone", () => {
    const r = new Redactor();
    r.add("alice@example.com", "github username");
    const result = r.result({
      content: [
        { type: "text", text: "Signed in as alice@example.com" },
        { type: "image", data: "abc", mimeType: "image/png" },
      ],
      structuredContent: { user: "alice@example.com" },
    });
    expect(result.content[0]).toEqual({ type: "text", text: "Signed in as [vault: github username]" });
    expect(result.content[1]).toEqual({ type: "image", data: "abc", mimeType: "image/png" });
    expect(result.structuredContent).toEqual({ user: "[vault: github username]" });
  });

  it("forgets a one-time code after its time, and ignores values too short to hide safely", () => {
    const r = new Redactor();
    r.add("123456", "github one-time code", 1000, 0);
    r.add("ab", "short");
    expect(r.text("code 123456 ab", 500)).toBe("code [vault: github one-time code] ab");
    expect(r.text("code 123456", 2000)).toBe("code 123456");
  });
});

describe("browser_login's recording guard", () => {
  it("names each option that would keep the filled values", () => {
    expect(recordingReason({})).toBeUndefined();
    expect(recordingReason({ saveSession: true })).toMatch(/--save-session/);
    expect(recordingReason({ saveVideo: { width: 800, height: 600 } })).toMatch(/video/);
    expect(recordingReason({ browser: { contextOptions: { recordHar: { path: "x.har" } } } })).toMatch(/HAR/);
    // The capability records nothing until the agent starts a trace or a video: checked per call.
    expect(recordingReason({ capabilities: ["devtools"] })).toBeUndefined();
  });
});
