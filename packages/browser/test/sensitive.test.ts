import { describe, expect, it } from "vitest";
import { REDACTED, credentialName, redactNetworkText } from "../src/network-redact.js";
import { Redactor } from "../src/redact.js";
import { SENSITIVE_MARK, fieldKind, maskSnapshot, maskSnapshotJSON, secretField } from "../src/sensitive.js";

const field = (o: Partial<{ type: string; autocomplete: string; name: string; id: string }>) => ({
  type: "text",
  autocomplete: "",
  name: "",
  id: "",
  ...o,
});

describe("the sensitive field classifier", () => {
  it("knows passwords and one-time codes by type, autocomplete, name and id", () => {
    expect(fieldKind(field({ type: "password" }))).toBe("password");
    expect(fieldKind(field({ type: "PASSWORD" }))).toBe("password");
    expect(fieldKind(field({ autocomplete: "section-a current-password" }))).toBe("password");
    expect(fieldKind(field({ autocomplete: "new-password" }))).toBe("password");
    expect(fieldKind(field({ name: "user[password]" }))).toBe("password");
    expect(fieldKind(field({ id: "confirmPassword" }))).toBe("password");
    expect(fieldKind(field({ name: "passcode" }))).toBe("password");
    expect(fieldKind(field({ autocomplete: "one-time-code" }))).toBe("one-time code");
    expect(fieldKind(field({ name: "otp-1" }))).toBe("one-time code");
    expect(fieldKind(field({ id: "totpCode" }))).toBe("one-time code");
    expect(fieldKind(field({ name: "mfa_code" }))).toBe("one-time code");
    expect(fieldKind(field({ name: "2fa" }))).toBe("one-time code");
    expect(fieldKind(field({ id: "oneTimeCode" }))).toBe("one-time code");
  });

  it("tells card and secret fields, which flows keep out but the agent may fill, from plain ones", () => {
    expect(fieldKind(field({ autocomplete: "cc-number" }))).toBe("card");
    expect(fieldKind(field({ id: "user_pin" }))).toBe("secret");
    expect(fieldKind(field({ name: "api_token" }))).toBe("secret");
    expect(fieldKind(field({ name: "email", autocomplete: "username" }))).toBeUndefined();
    expect(fieldKind(field({ name: "spinner" }))).toBeUndefined();
    expect(fieldKind(field({ name: "passport" }))).toBe("secret");
    // A word that only contains the letters is not a one-time code field.
    expect(fieldKind(field({ name: "footprint" }))).toBe("secret");
    expect(secretField(field({ name: "footprint" }))).toBe(true);
    expect(secretField(field({ name: "city" }))).toBe(false);
  });
});

describe("snapshot masking", () => {
  const snapshot = [
    "- generic [ref=e2]:",
    '  - textbox "Password" [ref=e6]: hunter22',
    '  - textbox "Digit" [active] [ref=e7] [cursor=pointer]: "4"',
    '  - textbox "User" [ref=e8]: ada',
    '  - textbox "Empty" [ref=e9]',
    "  - iframe [ref=e10]:",
    '    - textbox "Inner" [ref=f1e3]: inner-secret',
  ].join("\n");

  it("replaces the value of each sensitive ref, whatever its length, and nothing else", () => {
    const out = maskSnapshot(snapshot, new Set(["e6", "e7", "e9", "f1e3"]));
    expect(out).toContain(`textbox "Password" [ref=e6]: ${SENSITIVE_MARK}`);
    expect(out).toContain(`textbox "Digit" [active] [ref=e7] [cursor=pointer]: ${SENSITIVE_MARK}`);
    expect(out).toContain('textbox "User" [ref=e8]: ada');
    expect(out).toContain('textbox "Empty" [ref=e9]\n');
    expect(out).toContain(`textbox "Inner" [ref=f1e3]: ${SENSITIVE_MARK}`);
    expect(out).toContain("- generic [ref=e2]:");
    expect(maskSnapshot(snapshot, new Set())).toBe(snapshot);
  });

  it("masks the JSON form the same way", () => {
    const json = [
      {
        role: "generic",
        ref: "e2",
        children: ["Password", { role: "textbox", name: "Password", ref: "e6", text: "hunter22" }],
      },
      { role: "textbox", name: "User", ref: "e8", text: "ada" },
    ];
    const out = maskSnapshotJSON(json, new Set(["e6"])) as unknown as Record<string, unknown>[];
    expect(JSON.stringify(out)).not.toContain("hunter22");
    expect((out[0]!.children as unknown[])[1]).toEqual({
      role: "textbox",
      name: "Password",
      ref: "e6",
      text: SENSITIVE_MARK,
    });
    expect(out[1]).toEqual({ role: "textbox", name: "User", ref: "e8", text: "ada" });
  });
});

describe("values read from sensitive fields", () => {
  it("are redacted as the field mark in every encoding, codes only for a while", () => {
    const r = new Redactor();
    r.addField("Pers0n pw&", SENSITIVE_MARK);
    r.addField("482913", SENSITIVE_MARK, 1_000, 0);
    r.addField("ab", SENSITIVE_MARK);
    expect(r.text("a Pers0n pw& b Pers0n%20pw%26 c 482913 ab", 500)).toBe(
      `a ${SENSITIVE_MARK} b ${SENSITIVE_MARK} c ${SENSITIVE_MARK} ab`,
    );
    expect(r.text("482913", 2_000)).toBe("482913");
    expect(r.labelsIn("x Pers0n pw& x", (l) => /sensitive/.test(l))).toEqual(["sensitive field"]);
  });

  it("never take over a vault value's label, and a vault value takes over theirs", () => {
    const r = new Redactor();
    r.add("vault-pass-1", "github password");
    r.addField("vault-pass-1", SENSITIVE_MARK);
    expect(r.text("vault-pass-1")).toBe("[vault: github password]");
    r.addField("typed-pass-2", SENSITIVE_MARK);
    r.add("typed-pass-2", "gitlab password");
    expect(r.text("typed-pass-2")).toBe("[vault: gitlab password]");
  });
});

describe("credentials in network output", () => {
  it("tells credential names from the others", () => {
    for (const name of [
      "access_token",
      "id_token",
      "refresh_token",
      "token",
      "code",
      "session",
      "sid",
      "connect.sid",
      "PHPSESSID",
      "JSESSIONID",
      "sessionId",
      "api_key",
      "apiKey",
      "key",
      "secret",
      "client_secret",
      "password",
      "user[password]",
      "code_verifier",
      "X-Amz-Security-Token",
      "X-Amz-Signature",
      "x-api-key",
      "x-csrf-token",
      "auth_code",
      "id_token_hint",
    ])
      expect(credentialName(name), name).toBe(true);
    for (const name of [
      "page",
      "user",
      "name",
      "status_code",
      "country_code",
      "grant_type",
      "token_type",
      "token_endpoint",
      "expires_in",
      "state",
      "content-type",
      "sec-websocket-key",
      "authorization_endpoint",
    ])
      expect(credentialName(name), name).toBe(false);
  });

  it("redacts header values, keeping the scheme and cookie names", () => {
    const text = [
      "  Request headers",
      "    authorization: Bearer abc.def.ghi",
      "    proxy-authorization: Basic dXNlcjpwYXNz",
      "    cookie: sid=abc; theme=dark",
      "    x-api-key: k-123",
      "    accept: */*",
      "",
      "  Response headers",
      "    set-cookie: sid=new1; Path=/; HttpOnly",
      "other=new2; Secure",
      "    content-type: application/json",
    ].join("\n");
    const out = redactNetworkText(text);
    expect(out).toContain(`authorization: Bearer ${REDACTED}`);
    expect(out).toContain(`proxy-authorization: Basic ${REDACTED}`);
    expect(out).toContain(`cookie: sid=${REDACTED}; theme=${REDACTED}`);
    expect(out).toContain(`x-api-key: ${REDACTED}`);
    expect(out).toContain("accept: */*");
    expect(out).toContain(`set-cookie: sid=${REDACTED}; Path=/; HttpOnly`);
    expect(out).toContain(`other=${REDACTED}; Secure`);
    expect(out).toContain("content-type: application/json");
    for (const v of ["abc.def.ghi", "dXNlcjpwYXNz", "k-123", "new1", "new2"]) expect(out).not.toContain(v);
  });

  it("redacts query, fragment and form parameters, and JSON fields, keeping the rest", () => {
    expect(
      redactNetworkText("1. [GET] https://x.example/cb?code=c1&state=s1#access_token=t1&expires_in=60 => [200] OK"),
    ).toBe(
      `1. [GET] https://x.example/cb?code=${REDACTED}&state=s1#access_token=${REDACTED}&expires_in=60 => [200] OK`,
    );
    expect(redactNetworkText("grant_type=refresh_token&refresh_token=r1&client_secret=cs1")).toBe(
      `grant_type=refresh_token&refresh_token=${REDACTED}&client_secret=${REDACTED}`,
    );
    expect(redactNetworkText("user%5Bpassword%5D=p1&user%5Bemail%5D=a%40b")).toBe(
      `user%5Bpassword%5D=${REDACTED}&user%5Bemail%5D=a%40b`,
    );
    expect(redactNetworkText('{"access_token":"t1","expires_in":60,"user":{"name":"ada","session":"s1"}}')).toBe(
      `{"access_token":"${REDACTED}","expires_in":60,"user":{"name":"ada","session":"${REDACTED}"}}`,
    );
    expect(redactNetworkText('### Result\n{"password": "p1", "token": 123, "ok": true}')).toBe(
      `### Result\n{"password": "${REDACTED}", "token": "${REDACTED}", "ok": true}`,
    );
  });

  it("reads a JSON mode result field by field, keeping its layout", () => {
    const payload = {
      result: "#2 [POST] https://x.example/api?token=t1\n\n  Request headers\n    authorization: Bearer b1",
      page: "https://x.example/",
    };
    const out = redactNetworkText(JSON.stringify(payload, null, 2));
    expect(JSON.parse(out)).toEqual({
      result: `#2 [POST] https://x.example/api?token=${REDACTED}\n\n  Request headers\n    authorization: Bearer ${REDACTED}`,
      page: "https://x.example/",
    });
    expect(out).toBe(JSON.stringify(JSON.parse(out), null, 2));
    const plain = '{"a":1}';
    expect(redactNetworkText(plain)).toBe(plain);
  });
});
