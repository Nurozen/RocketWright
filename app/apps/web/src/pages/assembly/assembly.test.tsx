/**
 * M1.50 page 01 units: inspector cards from the contract CheckReport and
 * evaluated model, unit formatting, tree rows and icons, and the page slots
 * rendered over a store connected to the mock RPC server (selection from the
 * tree reaches the inspector; the eye toggle reaches `ui.hidden`).
 */
import { readFileSync } from "node:fs";
import type { CheckReport, EvaluatedModel } from "@rw/contracts";
import { type MockServer, SEED_PROJECT_ID, startMockServer } from "@rw/contracts/mock";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { ShellApp } from "../../shell/ShellApp.tsx";
import { PLACEHOLDER_SHELL } from "../../shell/model.ts";
import { componentRef, createAppStore, RpcClient, type AppStore } from "../../state/index.ts";
import { AssemblyToolbar } from "./AssemblyToolbar.tsx";
import { assemblySlots } from "./AssemblyPage.tsx";
import { ComponentTree, iconFor, treeLabel, treeRows } from "./ComponentTree.tsx";
import { Inspector } from "./Inspector.tsx";
import { formatLength, formatMass, formatPair, formatVolume, inspectorView, jointLabel } from "./inspector-model.ts";

const repo = new URL("../../../../../../", import.meta.url);
const fixture = <T,>(name: string): T => (JSON.parse(readFileSync(new URL(`fixtures/contracts/${name}.json`, repo), "utf8")) as { payload: T }).payload;
const evaluated = fixture<EvaluatedModel>("evaluated-model");
const check = fixture<CheckReport>("check-report");

const rows = (v: { key: string; value: string }[]) => Object.fromEntries(v.map((r) => [r.key, r.value]));

describe("units", () => {
  it("formats lengths, masses, and volumes", () => {
    expect(formatLength(0.12, "mm")).toBe("120 mm");
    expect(formatLength(0.0518, "mm")).toBe("51.8 mm");
    expect(formatLength(0.12, "cm")).toBe("12 cm");
    expect(formatLength(0.054, "in")).toBe("2.13 in");
    expect(formatLength(0.0005, "m")).toBe("0.0005 m");
    expect(formatLength(null, "mm")).toBe("—");
    expect(formatMass(0.054)).toBe("0.054 kg");
    expect(formatMass(1.234)).toBe("1.23 kg");
    expect(formatVolume(0.000127, "mm")).toBe("127 cm³");
    expect(jointLabel({ type: "twist_lock", count: 4 })).toBe("Twist lock (4×)");
    expect(jointLabel(null)).toBe("None");
  });
});

describe("inspector cards", () => {
  it("builds Attachment, Mass, and Clearance for the recovery bay from the model and CheckReport", () => {
    const v = inspectorView("recovery_bay", evaluated, check, "mm")!;
    expect(v.title).toBe("Recovery bay");
    expect(rows(v.attachment)).toEqual({ upper: "To Nosecone (base)", lower: "To Airframe tube (fore)", locking: "Twist lock (4×)" });
    expect(rows(v.mass)).toEqual({ mass: "0.054 kg", length: "120 mm", od: "54 mm" });
    const c = rows(v.clearance);
    expect(c["fits"]).toBe("51.8 mm (ID)");
    expect(c["required"]).toBe("≥ 0.5 mm");
    expect(c["total"]).toBe("120 mm");
    expect(v.clearance.find((r) => r.key.startsWith("rule:recovery_volume"))?.value).toBe("253 / ≥ 127 cm³");
  });

  it("lists each clearance finding once, with the unit written once", () => {
    // Two recovery items in one bay: the bay reports the same volume twice.
    const twice: CheckReport = {
      ...check,
      clearance: [
        { rule: "coupler_fit", a: "nose", b: "recovery_bay", dim: "length", actual: 0.0518, required: 0.0516, pass: true },
        { rule: "recovery_volume", a: "recovery_bay", b: "parachute", dim: "volume", actual: 0.000137, required: 0.000051, pass: true },
        { rule: "recovery_volume", a: "recovery_bay", b: "streamer", dim: "volume", actual: 0.000137, required: 0.000051, pass: true },
      ] as CheckReport["clearance"],
    };
    const v = inspectorView("recovery_bay", evaluated, twice, "mm")!;
    // The coupler fit is read off "Fits inside" + "Required" (same bore), so it is not repeated.
    expect(v.clearance.map((r) => [r.label, r.value])).toEqual([
      ["Fits inside", "51.8 mm (ID)"],
      ["Required", "≥ 51.6 mm"],
      ["Total length", "120 mm"],
      ["Recovery volume", "137 / ≥ 51 cm³"],
    ]);
    expect(formatPair(0.0404, 0.0402, "length", "mm")).toBe("40.4 / ≥ 40.2 mm");
    expect(formatPair(0.0004, 1.2, "mass", "mm")).toBe("0.0004 / ≥ 1.2 kg");
  });

  it("switches units for lengths only", () => {
    const v = inspectorView("recovery_bay", evaluated, check, "in")!;
    expect(rows(v.mass)).toMatchObject({ mass: "0.054 kg", length: "4.72 in", od: "2.13 in" });
  });

  it("describes inner parts by their mount and surfaces clearance diagnostics", () => {
    const chute = inspectorView("parachute", evaluated, check, "mm")!;
    expect(rows(chute.attachment)).toEqual({ mount: "In Recovery bay (inner)", offset: "+15 mm", locking: "None" });
    expect(rows(chute.clearance)["fits"]).toBe("51.8 mm (ID)");
    const ring = inspectorView("ring_lower", evaluated, check, "mm")!;
    const diag = ring.clearance.find((r) => r.key === "diag:RW-W151");
    expect(diag).toMatchObject({ severity: "warning", pass: false });
    expect(inspectorView("nope", evaluated, check, "mm")).toBeNull();
    expect(inspectorView("nose", null, check, "mm")).toBeNull();
  });

  it("renders the cards with their test ids", () => {
    const html = renderToStaticMarkup(<Inspector view={inspectorView("recovery_bay", evaluated, check, "mm")} />);
    for (const id of ["inspector", "insp.title", "insp.attachment", "insp.mass", "insp.clearance"]) expect(html).toContain(`data-testid="${id}"`);
    expect(html).toContain('data-rw-region="inspector"');
    expect(renderToStaticMarkup(<Inspector view={null} />)).toContain("Nothing selected");
  });
});

describe("components tree", () => {
  it("lists every component in model order with icons, hidden and selected state", () => {
    const r = treeRows(evaluated.components, ["lug"], ["recovery_bay"]);
    expect(r.map((x) => x.label)).toEqual(evaluated.components.map((c) => c.name));
    expect(r.find((x) => x.id === "lug")!.hidden).toBe(true);
    expect(r.find((x) => x.id === "recovery_bay")!).toMatchObject({ selected: true, icon: "recovery-bay" });
    const icons = Object.fromEntries(evaluated.components.map((c) => [c.id, iconFor(c)]));
    expect(icons).toMatchObject({ nose: "nose-cone", airframe: "body-tube", avionics: "electronics-bay", motor_mount: "motor", fins: "fin-set", parachute: "parachute" });
    const html = renderToStaticMarkup(<ComponentTree rows={r} onSelect={() => undefined} onToggleHidden={() => undefined} />);
    expect(html.match(/data-testid="tree\.eye"/g)).toHaveLength(evaluated.components.length);
    expect(html).toMatch(/data-part="lug"[^>]*data-hidden="true"/);
  });
});

describe("nested components tree", () => {
  // The research-vehicle shape: the airframe stack chains parents, contents nest.
  const comp = (id: string, type: string, parent: string | null) =>
    ({ id, name: id, parent, shape: { type } }) as unknown as EvaluatedModel["components"][number];
  const rv = [
    comp("nose", "nose_cone", null),
    comp("recovery_bay", "body_tube", "nose"),
    comp("chute", "parachute", "recovery_bay"),
    comp("airframe", "body_tube", "recovery_bay"),
    comp("ebay", "coupler", "airframe"),
    comp("flight_computer", "mass_component", "ebay"),
    comp("fin_can", "body_tube", "airframe"),
    comp("fins", "trapezoidal_fin_set", "fin_can"),
  ];

  it("labels instanced parts with their count", () => {
    const fins = { ...comp("fins", "trapezoidal_fin_set", "fin_can"), name: "Fins", instances: [{}, {}, {}, {}] } as unknown as EvaluatedModel["components"][number];
    expect(treeLabel(fins)).toBe("Fins (4)");
    expect(treeRows([...rv.slice(0, -1), fins], [], []).at(-1)!.label).toBe("Fins (4)");
    expect(treeLabel({ ...fins, name: "Fins (4)" })).toBe("Fins (4)");
    expect(treeLabel({ ...fins, instances: [{}] } as unknown as EvaluatedModel["components"][number])).toBe("Fins");
    expect(treeLabel(comp("nose", "nose_cone", null))).toBe("nose");
  });

  it("keeps the airframe stack top-level and nests parts under their body", () => {
    const r = treeRows(rv, [], []);
    expect(r.map((x) => `${x.depth}:${x.id}`)).toEqual(["0:nose", "0:recovery_bay", "1:chute", "0:airframe", "1:ebay", "2:flight_computer", "0:fin_can", "1:fins"]);
    expect(r.find((x) => x.id === "ebay")).toMatchObject({ hasChildren: true, collapsed: false });
  });

  it("collapses a subtree unless it holds the selection", () => {
    expect(treeRows(rv, [], [], ["airframe"]).map((x) => x.id)).toEqual(["nose", "recovery_bay", "chute", "airframe", "fin_can", "fins"]);
    expect(treeRows(rv, [], ["flight_computer"], ["airframe", "ebay"]).map((x) => x.id)).toContain("flight_computer");
    const html = renderToStaticMarkup(<ComponentTree rows={treeRows(rv, [], [], ["ebay"])} onSelect={() => undefined} onToggleHidden={() => undefined} />);
    expect(html).toMatch(/data-part="ebay"[^>]*aria-expanded="false"/);
    expect(html.match(/data-testid="tree\.twisty"/g)).toHaveLength(4);
  });
});

describe("toolbar", () => {
  it("renders every 01 control with its test id and state", () => {
    const noop = () => undefined;
    const html = renderToStaticMarkup(
      <AssemblyToolbar view="top" explode={0.6} section shadows={false} showInternals units="cm" onView={noop} onExplode={noop} onSection={noop} onShowInternals={noop} onShadows={noop} onUnits={noop} />,
    );
    for (const id of ["toolbar.view-chip", "toolbar.explode", "toolbar.section", "toolbar.show-internals", "toolbar.shadows", "toolbar.units"]) expect(html).toContain(`data-testid="${id}"`);
    expect(html).toMatch(/aria-checked="true"[^>]*>Top</);
    expect(html).toContain('value="60"');
    expect(html).toMatch(/role="switch"[^>]*aria-checked="true"/);
    expect(html).toContain("Assembled");
    expect(html).toContain('<option value="cm" selected="">cm</option>');
  });
});

describe("page slots on a live store (mock RPC)", () => {
  let srv: MockServer | null = null;
  let store: AppStore | null = null;
  let client: RpcClient | null = null;
  afterEach(async () => {
    store?.getState().project.disconnect();
    client?.close();
    await srv?.close();
    srv = store = client = null;
  });

  it("shares one selection between tree and inspector and hides parts through ui", async () => {
    srv = await startMockServer({ tickMs: 5, coreVersion: "0.0.0-mock" });
    client = await RpcClient.connect(srv.url);
    store = createAppStore({ loadWasm: async () => ({ coreVersion: () => "0.0.0-mock" }) });
    await store.getState().project.connect(client, SEED_PROJECT_ID);
    const glbDeps = { loadWasm: async () => ({}), fetchFixture: async () => new Uint8Array() };
    // Server rendering reads zustand's initial state; serve the current one instead.
    const ssr: AppStore = { ...store, getInitialState: store.getState };
    const render = () => renderToStaticMarkup(<ShellApp model={PLACEHOLDER_SHELL} page="01" assembly={assemblySlots(ssr, glbDeps)} />);

    let html = render();
    expect(html).toContain('data-testid="viewport"');
    expect(html).toContain('data-testid="vp.axis-gizmo"');
    expect(html).toContain("Nothing selected");
    expect(html.match(/data-testid="rail\.nav-row"/g)).toHaveLength(evaluated.components.length);

    store.getState().selection.select([componentRef("recovery_bay")], "tree");
    store.getState().ui.toggleHidden("lug");
    store.getState().ui.setView({ explode: 0.6, view: "side" });
    html = render();
    expect(html).toMatch(/data-testid="insp\.title"[^>]*>Recovery bay</);
    expect(html).toMatch(/data-part="recovery_bay"[^>]*aria-selected="true"/);
    expect(html).toMatch(/data-part="lug"[^>]*data-hidden="true"/);
    expect(html).toContain('data-selected="recovery_bay"');
    expect(html).toContain('data-explode="0.60"');
    expect(html).toContain('data-view="side"');
  });
});
