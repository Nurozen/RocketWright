/** Every place a material is named, in whichever file form the model includes it from. */
import { describe, expect, it } from "vitest";
import { componentSource, fieldTarget, materialUses, sourceMaterialIds, tableScalars } from "./source.ts";

const MANIFEST = 'name = "x"\nschema = 1\n';
const paths = (files: Record<string, string>, id = "al") => materialUses(files, id).map((u) => u.path);

const INCLUDES = (list: string[]): string => `include = [${list.map((f) => JSON.stringify(f)).join(", ")}]\n\n[materials.al]\ndensity = "2700 kg/m^3"\n`;

describe("materialUses", () => {
  it("finds a part in an included JSON file, with its name", () => {
    const files = {
      "rocketwright.toml": MANIFEST,
      "rocket.rw.toml": INCLUDES(["parts/fins.rw.json"]),
      "parts/fins.rw.json": JSON.stringify({ c: { fin: { type: "trapezoid_fins", name: "Fin set", material: "al" }, chute: { type: "parachute", line_material: "al" } } }),
    };
    expect(materialUses(files, "al")).toEqual([
      { path: "/c/fin/material", label: "Fin set" },
      { path: "/c/chute/line_material", label: "chute" },
    ]);
  });

  it("finds a part in a JSON main file and in what it includes, however deep", () => {
    const files = {
      "rocketwright.toml": MANIFEST,
      "rocket.rw.json": JSON.stringify({ include: ["parts/a.rw.toml"], c: { nose: { material: "al" } } }),
      "parts/a.rw.toml": 'include = ["parts/deep/b.rw.json"]\n\n[c.body]\nmaterial = "al"\n',
      "parts/deep/b.rw.json": JSON.stringify({ c: { tail: { material: "al" } } }),
    };
    expect(paths(files).sort()).toEqual(["/c/body/material", "/c/nose/material", "/c/tail/material"]);
  });

  it("finds a feed-graph tank in a TOML or JSON engine file, under the engine's id", () => {
    const files = {
      "rocket.rw.toml": "",
      "engines/hopper.rw.json": JSON.stringify({ name: "Hopper", feed: { node: { tank_a: { type: "tank", material: "al" }, valve: { type: "valve" } } } }),
      "engines/main.rw.toml": 'name = "Main"\n[feed.node.tank_b]\nmaterial = "al"\n',
    };
    expect(materialUses(files, "al").sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: "/engines/hopper/feed/node/tank_a/material", label: "Hopper tank_a" },
      { path: "/engines/main/feed/node/tank_b/material", label: "Main tank_b" },
    ]);
  });

  it("does not count a file the model does not include: a write there would fail", () => {
    const files = {
      "rocket.rw.toml": INCLUDES([]),
      "parts/spare.rw.json": JSON.stringify({ c: { spare: { material: "al" } } }),
      "parts/old.rw.toml": '[c.old]\nmaterial = "al"\n',
    };
    expect(paths(files)).toEqual([]);
  });

  it("follows the manifest's model file, written either way", () => {
    const rocket = '[c.nose]\nmaterial = "al"\n';
    expect(paths({ "rocketwright.toml": 'model = "v2.rw.toml"\n', "v2.rw.toml": rocket, "rocket.rw.toml": "" })).toEqual(["/c/nose/material"]);
    expect(paths({ "rocketwright.json": JSON.stringify({ model: "v2.rw.toml" }), "v2.rw.toml": rocket, "rocket.rw.toml": "" })).toEqual(["/c/nose/material"]);
  });

  it("gives one path to a part two files define: the model keeps the first", () => {
    const files = {
      "rocket.rw.toml": 'include = ["parts/x.rw.json"]\n[c.nose]\nmaterial = "al"\n',
      "parts/x.rw.json": JSON.stringify({ c: { nose: { material: "other" } } }),
    };
    expect(paths(files)).toEqual(["/c/nose/material"]);
    expect(paths(files, "other")).toEqual([]);
  });

  it("skips a file that does not parse", () => {
    const files = { "rocket.rw.toml": 'include = ["parts/x.rw.json"]\n[c.nose]\nmaterial = "al"\n', "parts/x.rw.json": "{ not json" };
    expect(paths(files)).toEqual(["/c/nose/material"]);
  });
});

describe("the merged source view reads JSON sources too", () => {
  const files = {
    "rocket.rw.toml": 'include = ["parts/x.rw.json"]\n',
    "parts/x.rw.json": JSON.stringify({ materials: { cf: { density: "1600 kg/m^3" } }, params: { span: { value: "90 mm" } }, c: { fin: { name: "Fin", span: "= params.span" } } }),
  };

  it("lists a material a JSON file defines, with its fields", () => {
    expect(sourceMaterialIds(files)).toEqual(["cf"]);
    expect(tableScalars(files, ["materials", "cf"])).toEqual({ density: "1600 kg/m^3" });
  });

  it("reads a JSON part's fields, so an expression there is still routed to its param", () => {
    expect(componentSource(files, "fin")).toEqual({ name: "Fin", span: "= params.span" });
    expect(fieldTarget(files, "fin", "span").path).toBe("/params/span/value");
  });
});
