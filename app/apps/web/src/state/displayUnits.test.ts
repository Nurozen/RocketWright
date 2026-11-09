import { describe, expect, it } from "vitest";
import { flightUnit, manifestDisplayUnits, toFlight, unitSystemOf } from "./displayUnits.ts";

const state = (units: "mm" | "in", manifest?: string) =>
  ({ ui: { units }, project: { snapshot: manifest === undefined ? null : { files: { files: { "rocketwright.toml": manifest } } } } }) as unknown as Parameters<typeof unitSystemOf>[0];

describe("flight display units", () => {
  it("converts SI at display only and keeps a missing value missing", () => {
    expect(toFlight(100, "length", "metric")).toBe(100);
    expect(toFlight(0.3048, "length", "imperial")).toBeCloseTo(1, 12);
    expect(toFlight(0.3048, "velocity", "imperial")).toBeCloseTo(1, 12);
    expect(toFlight(0.45359237, "mass", "imperial")).toBeCloseTo(1, 12);
    expect(toFlight(4.4482216152605, "force", "imperial")).toBeCloseTo(1, 9);
    expect(toFlight(0.44704, "wind", "imperial")).toBeCloseTo(1, 12);
    expect(toFlight(288.15, "temperature", "metric")).toBeCloseTo(15, 9);
    expect(toFlight(288.15, "temperature", "imperial")).toBeCloseTo(59, 9);
    expect(toFlight(101325, "pressure", "metric")).toBeCloseTo(1013.25, 9);
    expect(toFlight(null, "length", "imperial")).toBeNull();
    expect(toFlight(undefined, "length", "imperial")).toBeUndefined();
    expect(flightUnit("force", "imperial").unit).toBe("lbf");
  });

  it("reads only the manifest's [display_units] table", () => {
    expect(manifestDisplayUnits('name = "x"\nlength = "ft"\n\n[display_units] # shown\nlength = "in"\n altitude = "ft"  # flight\n\n[lib]\nmass = "kg"\n')).toEqual({ length: "in", altitude: "ft" });
    expect(manifestDisplayUnits(undefined)).toEqual({});
  });

  it("picks the system: the altitude key, then imperial lengths or the toolbar", () => {
    expect(unitSystemOf(state("mm"))).toBe("metric");
    expect(unitSystemOf(state("in"))).toBe("imperial");
    expect(unitSystemOf(state("mm", '[display_units]\nlength = "mm"\n'))).toBe("metric");
    expect(unitSystemOf(state("mm", '[display_units]\nlength = "in"\n'))).toBe("imperial");
    expect(unitSystemOf(state("mm", '[display_units]\nlength = "mm"\naltitude = "ft"\n'))).toBe("imperial");
    expect(unitSystemOf(state("in", '[display_units]\naltitude = "m"\n'))).toBe("metric");
  });
});
