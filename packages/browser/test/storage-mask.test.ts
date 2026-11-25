import { describe, expect, it } from "vitest";
import {
  MASK,
  cookieMaskReason,
  maskStorageValue,
  unmaskStorageState,
  unmaskStorageValue,
} from "../src/storage-mask.js";

/**
 * Which cookie and web storage values the model reads, on cookie shapes seen on real sites
 * (values replaced by random ones of the same form), and how a mask written back is resolved.
 */

describe("the masking rule", () => {
  it("masks HttpOnly cookies, credential names and random-looking values; keeps plain ones", () => {
    const masked: [string, string, boolean][] = [
      ["__cf_bm", "esFs9izVUNN1q69Uk2n5vu0PhEdWQMyGAWql.Jfa", true],
      ["user_city_ids", "533", true],
      ["PHPSESSID", "abc1", false],
      ["wordpress_logged_in_0123abcd", "alice", false],
      ["ct0", "9f4c1e2a7b3d4c5e6f708192a3b4c5d6e7f8091a2b3c4d5e", false],
      ["NetflixId", "v%3D3%26ct%3DBgjHlOvcAxL2Ao8kVb7nTqP0", false],
      ["_ga", "GA1.1.1304487852.1795638421", false],
    ];
    for (const [name, value, httpOnly] of masked)
      expect(cookieMaskReason({ name, value, httpOnly }), name).toBeDefined();
    const plain: [string, string][] = [
      ["preferred_color_mode", "light"],
      ["country", "MX"],
      ["_user_attributes", "%7B%22curr%22%3A%22MXN%22%7D"],
      ["psmLastActiveTimestamp", "2026-11-25T20%3A27%3A53.099Z"],
      ["OptanonAlertBoxClosed", "2026-11-25T20:27:53.099Z"],
      ["dismissed", "onboarding-banner-and-tour"],
    ];
    for (const [name, value] of plain) expect(cookieMaskReason({ name, value, httpOnly: false }), name).toBeUndefined();
  });

  it("keeps a JSON item's layout and plain fields, masking only its tokens", () => {
    const item = JSON.stringify({
      access_token: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl",
      expires_at: 1767225600,
      theme: "dark",
    });
    expect(JSON.parse(maskStorageValue("sb-auth", item))).toEqual({
      access_token: MASK,
      expires_at: 1767225600,
      theme: "dark",
    });
  });
});

describe("a mask written back", () => {
  it("stands for the value it hides in the same item, and for nothing anywhere else", () => {
    const current = JSON.stringify({ access_token: "Zk3pQ9xLr2Vt7mWb4Ns8Hy6Jc1Fd5Ga0", expires_at: 1 });
    const edited = JSON.stringify({ access_token: MASK, expires_at: 2 });
    expect(JSON.parse(unmaskStorageValue("auth", edited, current)!)).toEqual({
      access_token: "Zk3pQ9xLr2Vt7mWb4Ns8Hy6Jc1Fd5Ga0",
      expires_at: 2,
    });
    // Moved to a field the current value does not mask, or to an item that does not exist.
    expect(unmaskStorageValue("auth", JSON.stringify({ expires_at: MASK }), current)).toBeUndefined();
    expect(unmaskStorageValue("other", MASK, null)).toBeUndefined();
    expect(unmaskStorageValue("auth", `prefix ${MASK}`, current)).toBeUndefined();
  });

  it("restores a masked storage state from the live one, dropping masks with nothing behind them", () => {
    const cookie = { name: "sid", value: MASK, domain: "example.com", path: "/", httpOnly: true };
    const live = { cookies: [{ ...cookie, value: "live-session-value-0123456789" }], origins: [] };
    const { state, dropped } = unmaskStorageState(
      { cookies: [cookie, { ...cookie, domain: "attacker.test" }], origins: [] },
      live,
    );
    expect(state.cookies).toEqual([{ ...cookie, value: "live-session-value-0123456789" }]);
    expect(dropped).toBe(1);
  });
});
