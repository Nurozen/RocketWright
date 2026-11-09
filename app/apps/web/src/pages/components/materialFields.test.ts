import { describe, expect, it } from "vitest";
import { blankForm, buildMaterial, densityKeyFor, densitySummary, formFromEval, formFromLiterals, isDirty, libraryKey, libraryMaterial, materialChoices, validateForm, type MaterialForm } from "./materialFields.ts";

const form = (over: Partial<MaterialForm>): MaterialForm => ({ ...blankForm(1), ...over });
const values = (density = "", surface_density = "", line_density = "") => ({ density, surface_density, line_density });

describe("which material a part can use", () => {
  it("follows the density kind the model checks for each part kind", () => {
    expect(densityKeyFor("body_tube")).toBe("density");
    expect(densityKeyFor("trapezoidal_fin_set")).toBe("density");
    expect(densityKeyFor("parachute")).toBe("surface_density");
    expect(densityKeyFor("streamer")).toBe("surface_density");
    expect(densityKeyFor("shock_cord")).toBe("line_density");
    expect(densityKeyFor("mass_component")).toBeNull();
  });

  const materials = { card: { density: 680 }, ripstop: { surface_density: 0.067 }, cord: { line_density: 0.0018 } };

  it("lists only the materials with that density, sorted", () => {
    expect(materialChoices(materials, "surface_density", null)).toEqual(["ripstop"]);
    expect(materialChoices(materials, "line_density", null)).toEqual(["cord"]);
    expect(materialChoices(materials, null, null)).toEqual(["card", "cord", "ripstop"]);
  });

  it("keeps a wrong-kind value the part already holds, so the select shows the truth", () => {
    expect(materialChoices(materials, "density", "ripstop")).toEqual(["card", "ripstop"]);
    expect(materialChoices(materials, "density", "card")).toEqual(["card"]);
  });
});

describe("the form", () => {
  it("is dirty once something is typed, and not for a value put back", () => {
    expect(isDirty(blankForm(1))).toBe(false);
    expect(isDirty(form({ name: "foam" }))).toBe(true);
    expect(isDirty(form({ values: values("100") }))).toBe(true);
    expect(isDirty(form({ id: "foam", name: "foam", values: values("100"), baseline: values("100") }))).toBe(false);
  });

  it("refuses text that is not a positive number, field by field", () => {
    expect(validateForm(form({ values: values("abc", "-1", "0") }), new Set())).toEqual({ density: "Density needs a number.", surface_density: "Surface density must be greater than 0.", line_density: "Line density must be greater than 0." });
    expect(validateForm(form({ values: values("100") }), new Set())).toEqual({});
  });

  it("refuses a new name whose id is taken, and an existing material with no density left", () => {
    expect(validateForm(form({ name: "Ripstop Nylon" }), new Set(["ripstop_nylon"])).name).toContain("already has a material called Ripstop Nylon");
    expect(validateForm(form({ id: "foam", name: "foam" }), new Set(["foam"]))).toEqual({ form: "A material needs at least one density." });
  });
});

describe("what gets written", () => {
  it("writes each typed density as a source literal the engine parses", () => {
    expect(buildMaterial(form({ values: values("1050") }), {}, "mm")).toEqual({ density: "1050 kg/m^3" });
    expect(buildMaterial(form({ values: values("", "67") }), {}, "mm")).toEqual({ surface_density: "67 g/m^2" });
    expect(buildMaterial(form({ values: values("", "", "1.8") }), {}, "in")).toEqual({ line_density: "1.8 g/m" });
    expect(buildMaterial(form({}), {}, "mm")).toBeNull();
  });

  it("keeps what it does not edit: other keys, and the literal of a field left alone", () => {
    const f = form({ id: "foam", values: values("120", "67"), baseline: values("110", "67") });
    expect(buildMaterial(f, { doc: "Foam", yield_strength: "2 MPa", density: "110.0 kg/m^3", surface_density: "= params.s" }, "mm")).toEqual({ doc: "Foam", yield_strength: "2 MPa", density: "120 kg/m^3", surface_density: "= params.s" });
  });

  it("drops a density the form cleared", () => {
    const f = form({ id: "foam", values: values("", "67"), baseline: values("110", "67") });
    expect(buildMaterial(f, { density: "110 kg/m^3", surface_density: "67 g/m^2" }, "mm")).toEqual({ surface_density: "67 g/m^2" });
  });

  it("loads a form in display units", () => {
    const f = formFromEval("ripstop_nylon", { surface_density: 0.067 }, 3, "mm");
    expect(f).toMatchObject({ id: "ripstop_nylon", name: "ripstop nylon", session: 3 });
    expect(f.values).toEqual(values("", "67"));
    expect(isDirty(f)).toBe(false);
    expect(formFromLiterals("fiber", { density: "657.0 kg/m^3", doc: "Fiber" }, 1, "mm").values.density).toBe("657");
  });

  it("summarises what a material defines", () => {
    expect(densitySummary({ density: 680 }, "mm")).toBe("680 kg/m³");
    expect(densitySummary({ line_density: "3.3E-4 kg/m", doc: "Thread" }, "mm")).toBe("0.33 g/m");
    expect(densitySummary(undefined, "mm")).toBe("");
  });
});

describe("the library", () => {
  it("reads the key from either id form", () => {
    expect(libraryKey({ id: "preset:estes_classic/materials/fiber_bulk" })).toBe("fiber_bulk");
    expect(libraryKey({ id: "lib:lib/mats.rw.toml#foam" })).toBe("foam");
  });

  it("copies only what a project material holds", () => {
    expect(libraryMaterial({ data: { density: "657.0 kg/m^3", doc: "Fiber", extra: 1 } })).toEqual({ density: "657.0 kg/m^3", doc: "Fiber" });
  });
});
