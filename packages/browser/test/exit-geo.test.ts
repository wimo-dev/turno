import { describe, expect, it } from "vitest";
import { geoProblems, likelyLocale, parseGeo } from "../src/exit-geo.js";

/** The exit check: the lookup's reply, and what it compares with what the identity presents. */

/** A GeoJS reply in its real shape (the address is a documentation one). */
const REPLY = JSON.stringify({
  organization_name: "Example Transit",
  region: "Nuevo Leon",
  accuracy: 1000,
  asn: 64500,
  organization: "AS64500 Example Transit",
  timezone: "America/Monterrey",
  longitude: "-100.31",
  country_code3: "MEX",
  area_code: "0",
  ip: "203.0.113.7",
  city: "Monterrey",
  country: "Mexico",
  continent_code: "NA",
  country_code: "MX",
  latitude: "25.64",
});

describe("the exit check", () => {
  it("keeps only the country and the time zone of the reply", () => {
    expect(parseGeo(REPLY)).toEqual({ country: "MX", timezone: "America/Monterrey" });
    expect(parseGeo("<html>")).toHaveProperty("error");
  });

  it("warns when the time zone's offset or the locale's region differs from the exit, and not otherwise", () => {
    const at = new Date("2026-11-25T12:00:00Z");
    const exit = { country: "MX", timezone: "America/Monterrey" };
    expect(geoProblems(exit, { timezone: "America/Mexico_City", locale: "es-MX" }, at)).toEqual([]);
    const off = geoProblems(exit, { timezone: "Europe/Madrid", locale: "en-US" }, at);
    expect(off).toHaveLength(2);
    expect(off[0]).toContain("--timezone America/Monterrey");
    expect(off[1]).toContain("es-MX would match it");
    expect(likelyLocale("BR")).toBe("pt-BR");
  });
});
