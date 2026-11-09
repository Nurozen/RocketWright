/** U23: the palette's placements, checked against the real core: what it offers, the sidecar accepts. */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CONTAINMENT, containmentAllowed, type EvaluatedModel, type PatchOp, type schema } from "@rw/contracts";
import { loadRwWasm } from "@rw/rw-wasm";
import { beforeAll, describe, expect, it } from "vitest";
import { addPartOps, PART_KINDS, type PartKind } from "../../state/ops/parts.ts";
import { fromRwWasm, type PreviewCore } from "../../state/wasm.ts";
import { attachmentFor, defaultParent, parentChoices, ROOT_KINDS } from "./attach-targets.ts";

const repo = new URL("../../../../../../", import.meta.url).pathname;

function files(rel: string): Record<string, string> {
  const root = join(repo, rel);
  const out: Record<string, string> = {};
  const walk = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, `${prefix}${name}/`);
      else out[`${prefix}${name}`] = readFileSync(p, "utf8");
    }
  };
  walk(root, "");
  return out;
}

let core: Required<PreviewCore>;
let empty: Record<string, string>;
let base: PatchOp[];
let model: EvaluatedModel;

const add = (kind: PartKind, taken: string[], to?: string): PatchOp[] => addPartOps({ kind, taken, ...(to === undefined ? {} : { attach: { to } as schema.Attach }) }).ops;

beforeAll(async () => {
  const rw = await loadRwWasm(readFileSync(new URL("../../../../../packages/rw-wasm/pkg/rw_wasm_bg.wasm", import.meta.url)));
  core = fromRwWasm(rw) as Required<PreviewCore>;
  empty = files("templates/empty");
  // One of each kind of parent: nose, tube, transition, then a coupler and an inner tube inside the tube.
  base = [
    ...add("nose_cone", []),
    ...add("body_tube", ["nose_cone"], "nose_cone.base"),
    ...add("transition", ["nose_cone", "body_tube"], "body_tube.aft"),
    ...add("coupler", ["nose_cone", "body_tube", "transition"], "body_tube.inner"),
    ...add("inner_tube", ["nose_cone", "body_tube", "transition", "coupler"], "body_tube.inner"),
  ];
  model = core.applyAndCheck({ files: empty, ops: base }).evaluated;
});

/** Placement and containment errors (RW-E03x, RW-E05x): what the palette must never cause. */
const placementErrors = (ds: readonly schema.Diagnostic[]) => ds.filter((d) => d.severity === "error" && /^RW-E0[35]/.test(d.code)).map((d) => `${d.code} ${d.path}: ${d.message}`);

describe("attachmentFor", () => {
  it("leaves the test rocket free of placement errors", () => {
    expect(placementErrors(core.applyAndCheck({ files: empty, ops: base }).check.diagnostics)).toEqual([]);
  });

  it("offers only placements the core accepts, for every kind on every parent", () => {
    const refused: string[] = [];
    let offered = 0;
    for (const kind of PART_KINDS) {
      for (const parent of parentChoices(model.components)) {
        const attach = attachmentFor(kind, parent);
        if (attach === null) continue;
        offered++;
        const ops = [...base, ...addPartOps({ kind, taken: model.components.map((c) => c.id), attach }).ops];
        refused.push(...placementErrors(core.applyAndCheck({ files: empty, ops }).check.diagnostics).map((e) => `${kind} on ${parent.id}: ${e}`));
      }
    }
    expect(refused).toEqual([]);
    expect(offered).toBeGreaterThan(40);
  });

  it("detects a bad placement when one is made", () => {
    const ops = [...base, ...addPartOps({ kind: "nose_cone", taken: model.components.map((c) => c.id), attach: { to: "body_tube.aft" } as schema.Attach }).ops];
    expect(placementErrors(core.applyAndCheck({ files: empty, ops }).check.diagnostics).join(" ")).toContain("RW-E030");
  });

  it("gives every kind but the nose cone a place on a tube", () => {
    const tube = model.components.find((c) => c.id === "body_tube")!;
    expect(PART_KINDS.filter((k) => attachmentFor(k, tube) === null)).toEqual(["nose_cone"]);
  });

  it("stacks a tube on the nose and hangs fins off the tail", () => {
    const nose = model.components.find((c) => c.id === "nose_cone")!;
    const tube = model.components.find((c) => c.id === "body_tube")!;
    expect(attachmentFor("body_tube", nose)).toEqual({ to: "nose_cone.base" });
    expect(attachmentFor("trapezoidal_fin_set", tube)).toEqual({ to: "body_tube.aft", at: "root_te" });
  });

  it("keeps a tank to the parents the core allows", () => {
    const allowed = model.components.filter((c) => attachmentFor("tank", c) !== null).map((c) => c.id);
    expect(allowed).toEqual(["body_tube", "coupler"]);
  });
});

describe("the generated table", () => {
  it("decides every kind on every parent, short only of an anchor the parent lacks", () => {
    const noPlace: string[] = [];
    for (const kind of PART_KINDS) {
      for (const parent of parentChoices(model.components)) {
        const allowed = containmentAllowed(parent.shape.type as PartKind, kind, CONTAINMENT.natural_kind[kind]);
        const attach = attachmentFor(kind, parent);
        if (!allowed) expect(attach, `${kind} on ${parent.id}`).toBeNull();
        else if (attach === null) noPlace.push(parent.shape.type);
      }
    }
    // A default nose cone or transition is solid, so it has no `inner` anchor to hold anything.
    expect(new Set(noPlace)).toEqual(new Set(["nose_cone", "transition"]));
  });

  it("offers as parents exactly the kinds some rule lets hold a part", () => {
    expect(parentChoices(model.components).map((c) => c.id).sort()).toEqual(["body_tube", "coupler", "inner_tube", "nose_cone", "transition"]);
  });
});

describe("root and default parent", () => {
  it("lists the body kinds as roots", () => {
    expect(ROOT_KINDS).toEqual(["nose_cone", "body_tube", "transition"]);
  });

  it("prefers the selected part, then the tail of the stack", () => {
    expect(defaultParent(model.components, ["coupler"])?.id).toBe("coupler");
    expect(defaultParent(model.components, [])?.id).toBe("transition");
    expect(defaultParent(model.components, ["missing"])?.id).toBe("transition");
    expect(defaultParent([], [])).toBeNull();
  });

  it("does not offer non-containers as parents", () => {
    const fins = core.applyAndCheck({ files: empty, ops: [...base, ...addPartOps({ kind: "trapezoidal_fin_set", taken: model.components.map((c) => c.id), attach: { to: "body_tube.aft" } as schema.Attach }).ops] }).evaluated;
    expect(parentChoices(fins.components).map((c) => c.id)).not.toContain("trapezoidal_fin_set");
  });
});
