/** U46: every named dimension round-trips through the field unit and never writes a bare number. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { displayUnit, fromDisplay, parseLiteral, toDisplay, toSource } from "./units.ts";

const repo = new URL("../../../../../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, repo), "utf8");

const engineDims = [...read("crates/rw-units/src/dim.rs").matchAll(/^\s+\w+ => "(\w+)", \w+, \(/gm)].map((m) => m[1]!).filter((d) => d !== "dimensionless");
const schemaDims = (name: string) => [...read(`schema/${name}.json`).matchAll(/"x-unit-dimension":\s*"(\w+)"/g)].map((m) => m[1]!).filter((d) => d !== "dimensionless");
const dimensions = [...new Set([...engineDims, ...schemaDims("rocket"), ...schemaDims("sim")])];

describe("field units", () => {
  it("sees every dimension the engine names", () => {
    expect(engineDims).toEqual(expect.arrayContaining(["length", "density", "area_density", "line_density", "velocity", "pressure", "temperature", "force", "volume", "acceleration"]));
  });

  it.each(dimensions)("%s writes a unit, and the literal reads back to the same SI value", (dim) => {
    for (const units of ["mm", "in"] as const) {
      const u = displayUnit(dim, units);
      expect(u.unit, dim).not.toBe("");
      const source = toSource(12.5, dim, units);
      expect(typeof source, dim).toBe("string");
      expect(source, dim).toMatch(/^12\.5 \S/);
      expect(parseLiteral(source), `${dim} ${String(source)}`).toBeCloseTo(fromDisplay(12.5, dim, units), 6);
      // Display of the SI value returns what was typed.
      expect(toDisplay(fromDisplay(12.5, dim, units), dim, units)).toBe("12.5");
    }
  });

  it("shows temperature in Celsius and stores kelvin, with the offset", () => {
    expect(toDisplay(293.15, "temperature", "mm")).toBe("20");
    expect(fromDisplay(20, "temperature", "mm")).toBeCloseTo(293.15, 9);
    expect(toSource(20, "temperature", "mm")).toBe("20 degC");
    expect(parseLiteral("20 degC")).toBeCloseTo(293.15, 9);
    expect(parseLiteral("68 degF")).toBeCloseTo(293.15, 6);
    expect(parseLiteral("300 K")).toBe(300);
  });

  it("shows the units the rest of the app states", () => {
    expect(displayUnit("density", "mm").unit).toBe("kg/m³");
    expect(displayUnit("area_density", "mm").unit).toBe("g/m²");
    expect(displayUnit("line_density", "mm").unit).toBe("g/m");
    expect(toSource(1050, "density", "mm")).toBe("1050 kg/m^3");
    expect(toSource(45, "area_density", "mm")).toBe("45 g/m^2");
    expect(toSource(3, "line_density", "mm")).toBe("3 g/m");
    expect(parseLiteral("1050 kg/m^3")).toBe(1050);
    expect(parseLiteral("1050 kg/m³")).toBe(1050);
    expect(parseLiteral("45 g/m^2")).toBeCloseTo(0.045, 12);
  });

  it("pins a unit where a toolbar unit would round it away", () => {
    expect(displayUnit("length:um", "mm").unit).toBe("µm");
    expect(toDisplay(60e-6, "length:um", "mm")).toBe("60");
    expect(toSource(60, "length:um", "mm")).toBe("60 um");
    expect(parseLiteral("60 um")).toBeCloseTo(60e-6, 12);
    expect(parseLiteral("60 µm")).toBeCloseTo(60e-6, 12);
    expect(toSource(2, "length:m", "mm")).toBe("2 m");
  });

  it("writes a plain number only for a dimensionless field, and refuses an unknown dimension", () => {
    expect(toSource(4, undefined, "mm")).toBe(4);
    expect(toSource(0.8, "dimensionless", "mm")).toBe(0.8);
    expect(() => toSource(1, "made_up", "mm")).toThrow(/made_up/);
  });
});
