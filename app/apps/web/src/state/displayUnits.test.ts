import { describe, expect, it } from "vitest";
import { displayLengthOps, flightUnit, manifestDisplayUnits, toFlight, unitSystemOf } from "./displayUnits.ts";

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

  it("reads every TOML form of the table", () => {
    expect(manifestDisplayUnits("[display_units]\nlength = 'in'\n")).toEqual({ length: "in" });
    expect(manifestDisplayUnits('display_units = { length = "in", altitude = "ft" }\n')).toEqual({ length: "in", altitude: "ft" });
    expect(manifestDisplayUnits('[project]\nname = "x"\n\n[display_units]\n"length" = "cm"\n')).toEqual({ length: "cm" });
    expect(unitSystemOf(state("mm", "display_units = { length = 'in' }\n"))).toBe("imperial");
    expect(manifestDisplayUnits("this is = = not toml")).toEqual({});
  });

  it("writes per key when the table is already there in any form", () => {
    expect(displayLengthOps('display_units = { length = "in" }\n', "cm")).toEqual([{ op: "add", path: "/project/display_units/length", value: "cm" }]);
    expect(displayLengthOps('display_units.length = "in"\n', "cm")).toEqual([{ op: "add", path: "/project/display_units/length", value: "cm" }]);
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

describe("the units control's edit", () => {
  const table = (body: string) => `format = 1\n\n[display_units]\n${body}`;

  it("sets the length key of a table that exists, leaving the rest", () => {
    expect(displayLengthOps(table('length = "mm"\nmass = "g"\n'), "cm")).toEqual([{ op: "add", path: "/project/display_units/length", value: "cm" }]);
  });

  it("adds a table to a manifest with none", () => {
    expect(displayLengthOps('format = 1\nname = "x"\n', "in")).toEqual([{ op: "add", path: "/project/display_units", value: { length: "in" } }]);
    expect(displayLengthOps(undefined, "m")).toEqual([{ op: "add", path: "/project/display_units", value: { length: "m" } }]);
  });

  it("still writes the choice when the mirror already says it: quick changes race the mirror, and skipping would strand an older write", () => {
    expect(displayLengthOps(table('length = "mm"\n'), "mm")).toEqual([{ op: "add", path: "/project/display_units/length", value: "mm" }]);
  });

  it("moves an altitude key across systems, so flight results follow the choice", () => {
    expect(displayLengthOps(table('length = "mm"\naltitude = "m"\n'), "in")).toEqual([
      { op: "add", path: "/project/display_units/length", value: "in" },
      { op: "add", path: "/project/display_units/altitude", value: "ft" },
    ]);
    expect(displayLengthOps(table('length = "in"\naltitude = "ft"\n'), "m")).toEqual([
      { op: "add", path: "/project/display_units/length", value: "m" },
      { op: "add", path: "/project/display_units/altitude", value: "m" },
    ]);
  });

  it("leaves an altitude key alone within a system", () => {
    expect(displayLengthOps(table('length = "mm"\naltitude = "km"\n'), "cm")).toEqual([{ op: "add", path: "/project/display_units/length", value: "cm" }]);
  });

  it("agrees with the unit system the results read", () => {
    const manifest = table('length = "mm"\naltitude = "m"\n');
    const write = displayLengthOps(manifest, "in");
    expect(write.find((o) => o.path.endsWith("altitude"))).toMatchObject({ value: "ft" });
    expect(unitSystemOf(state("in", table('length = "in"\naltitude = "ft"\n')))).toBe("imperial");
  });
});
