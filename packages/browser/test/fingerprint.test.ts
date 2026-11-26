import { describe, expect, it } from "vitest";
import { type Fingerprint, differences, urlPattern } from "../src/fingerprint.js";

describe("fingerprint", () => {
  it("matches pages by origin and path, with ids in the path as *", () => {
    expect(urlPattern("https://shop.example.com/orders/12345/edit?tab=2#x")).toBe(
      "https://shop.example.com/orders/*/edit",
    );
    expect(urlPattern("https://example.com/u/3f2a9c1e-77aa-4c1d-9a0b-1234567890ab")).toBe("https://example.com/u/*");
    expect(urlPattern("https://example.com/settings/profile")).toBe("https://example.com/settings/profile");
  });

  it("tells a moved element from another one", () => {
    const save: Fingerprint = { role: "button", name: "Save", landmark: 'form "Profile"', url: "https://e.com/p" };
    expect(differences(save, { ...save, name: "save" })).toEqual([]);
    expect(differences(save, { ...save, name: "Delete" })).toEqual(['its name is "Delete", not "Save"']);
    expect(differences(save, { ...save, role: "link" })).toEqual(["it is a link, not a button"]);
    expect(differences(save, { ...save, landmark: "navigation" })).toEqual([
      'it is in navigation, not in form "Profile"',
    ]);
  });
});
