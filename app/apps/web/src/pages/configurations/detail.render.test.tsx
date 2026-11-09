/**
 * R19-03 page 03: the motor detail (title, curve, casing) follows the
 * selected configuration's mounted motor, `configs.<id>.motors.<mount>.motor`;
 * a comparison candidate picked in the list shows only for the configuration,
 * mount, and mounted motor it was picked against (`detailMotorRef`).
 */
import type { EvaluatedModel, ProjectSnapshot, schema } from "@rw/contracts";
import { MockRpc } from "@rw/contracts/mock";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it } from "vitest";
import { createStore } from "zustand/vanilla";
import { createAppStore, type AppStore } from "../../state/store.ts";
import type { AppState, DeepReadonly } from "../../state/types.ts";
import { configurationsSlots, createConfigurationsUi, type ConfigurationsUi } from "./ConfigurationsPage.tsx";
import { detailMotorRef, motorMounts, type MotorPick } from "./model.ts";

const mock = new MockRpc({ testHooks: false });
afterAll(() => mock.dispose());

const curve = (id: string, cls: string, d: number): schema.ThrustCurve =>
  ({
    designation: id,
    manufacturer: "RocketWright",
    class: cls,
    diameter: d,
    length: 0.07,
    delays: [3, 5],
    prop_mass: 0.01,
    total_mass: 0.02,
    total_impulse: 5,
    burn_time: 1,
    average_thrust: 5,
    max_thrust: 15,
    points: [
      { t: 0, thrust: 0 },
      { t: 0.2, thrust: 15 },
      { t: 1, thrust: 0 },
    ],
    sha256: "0",
    source: { kind: "generic", id },
  }) as schema.ThrustCurve;
// The list order puts another motor first, so a fallback to the first row would show.
const LIBRARY = [curve("RW_A8G", "A", 0.018), curve("RW_B4G", "B", 0.018), curve("RW_C6G", "C", 0.018)];

/** The mock project with Baseline on RW_B4G and Higher altitude on RW_C6G (the page-03 capture's vehicle). */
function snapshot(motors: Record<string, string>): ProjectSnapshot {
  const snap = structuredClone(mock.snapshot());
  const model = snap.evaluated as EvaluatedModel;
  for (const [id, motor] of Object.entries(motors)) for (const a of model.configs[id]!.motors) a.motor = motor;
  return snap;
}

function appStore(snap: ProjectSnapshot, config: string): AppStore {
  const base = createAppStore({ loadWasm: () => Promise.reject(new Error("no wasm in tests")) }).getState();
  const state: AppState = {
    ...base,
    project: { ...base.project, projectId: "research-vehicle", snapshot: snap as DeepReadonly<ProjectSnapshot> },
    selection: { ...base.selection, refs: [`rw:cfg/${config}`] },
  };
  return createStore<AppState>()(() => state);
}

/** The page's markup for `config` (SSR reads a store's initial state: the page UI store has the library loaded and the pick in place). */
function pageHtml(snap: ProjectSnapshot, config: string, pick: MotorPick | null, over: Partial<ConfigurationsUi> = {}): string {
  const initial: ConfigurationsUi = { ...createConfigurationsUi().getState(), library: { state: "ready", motors: LIBRARY }, pick, ...over };
  const ui = createStore<ConfigurationsUi>()(() => initial);
  return renderToStaticMarkup(<>{configurationsSlots(appStore(snap, config), null, ui).content}</>);
}

/** Renders the page and returns the detail's motor id and the configuration's mounted motor. */
function render(snap: ProjectSnapshot, config: string, pick: MotorPick | null): { detail: string | null; mounted: string } {
  const html = pageHtml(snap, config, pick);
  const model = snap.evaluated as EvaluatedModel;
  const mount = motorMounts(model)[0]!.id;
  const mounted = model.configs[config]!.motors.find((a) => a.mount === mount)!.motor!;
  return { detail: /data-testid="motor\.detail" data-motor="([^"]+)"/.exec(html)?.[1] ?? null, mounted };
}

const MOTORS = { baseline: "generic:RW_B4G", higher_altitude: "generic:RW_C6G", recovery_test: "generic:RW_A8G" };

describe("motor detail follows the selected configuration (R19-03)", () => {
  it("shows configs.<selected>.motors.<mount>.motor for each configuration", () => {
    const snap = snapshot(MOTORS);
    for (const id of Object.keys(MOTORS)) {
      const { detail, mounted } = render(snap, id, null);
      expect(detail).toBe(mounted);
      expect(detail).toBe(MOTORS[id as keyof typeof MOTORS]);
    }
  });

  it("shows a candidate only for the configuration, mount, and mounted motor it was picked against", () => {
    const snap = snapshot(MOTORS);
    const mount = motorMounts(snap.evaluated as EvaluatedModel)[0]!.id;
    const pick: MotorPick = { key: `baseline/${mount}`, base: "generic:RW_B4G", motor: "generic:RW_C6G" };
    // Picked on Baseline: the comparison candidate shows there.
    expect(render(snap, "baseline", pick).detail).toBe("generic:RW_C6G");
    // Another configuration selected: its own mounted motor, never the candidate.
    const recovery = render(snap, "recovery_test", pick);
    expect(recovery.detail).toBe(recovery.mounted);
    // Baseline's motor changed since the pick (assign, agent patch, undo): the new mounted motor.
    const changed = render(snapshot({ ...MOTORS, baseline: "generic:RW_A8G" }), "baseline", pick);
    expect(changed.detail).toBe(changed.mounted);
    expect(changed.detail).toBe("generic:RW_A8G");
  });

  it("resolves the detail motor ref", () => {
    const pick: MotorPick = { key: "a/m", base: "generic:X", motor: "generic:Y" };
    expect(detailMotorRef(null, "a/m", "generic:X")).toBe("generic:X");
    expect(detailMotorRef(pick, "a/m", "generic:X")).toBe("generic:Y");
    expect(detailMotorRef(pick, "b/m", "generic:X")).toBe("generic:X");
    expect(detailMotorRef(pick, "a/n", "generic:X")).toBe("generic:X");
    expect(detailMotorRef(pick, "a/m", "generic:Z")).toBe("generic:Z");
    expect(detailMotorRef(pick, "a/m", null)).toBeNull();
  });
});

/** Baseline on RW_B4G (listed delays 3, 5 s in this library) with its ejection delay set to `delay` s. */
function withDelay(delay: number): ProjectSnapshot {
  const snap = snapshot(MOTORS);
  const model = snap.evaluated as EvaluatedModel;
  for (const a of model.configs["baseline"]!.motors) (a as { delay?: number | null }).delay = delay;
  return snap;
}

const attr = (html: string, testid: string, name: string) => new RegExp(`<[^>]*data-testid="${testid.replace(".", "\\.")}"[^>]*>`).exec(html)?.[0].match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? null;

describe("ejection delay source (R20-03)", () => {
  it("a delay the motor file does not list is custom: the tag, the unticked box, and its label agree", () => {
    const html = pageHtml(withDelay(4), "baseline", null);
    expect(attr(html, "motor.delay-source", "data-source")).toBe("custom");
    expect(html).toMatch(/data-testid="motor\.delay-source"[^>]*>Custom</);
    // The box is unticked and says so, naming the delays the file does list; never "Custom delay" beside an unticked box.
    expect(/<input[^>]*data-testid="motor\.use-file"[^>]*>/.exec(html)![0]).not.toContain("checked");
    expect(html).toMatch(/data-testid="motor\.use-file-label">Off · lists 3, 5 s</);
    expect(html).not.toContain("Custom delay");
    // The custom value shows in a typed field, and the note says the delay is this configuration's.
    expect(/<input[^>]*data-testid="motor\.delay"[^>]*>/.exec(html)![0]).toContain('value="4"');
    expect(html).toContain("ejection delay 4 s for Baseline");
  });

  it("a listed delay is the manufacturer's: the tag, the ticked box, and the listed choices agree", () => {
    const html = pageHtml(withDelay(3), "baseline", null);
    expect(attr(html, "motor.delay-source", "data-source")).toBe("manufacturer");
    expect(html).toMatch(/data-testid="motor\.delay-source"[^>]*>Manufacturer</);
    expect(/<input[^>]*data-testid="motor\.use-file"[^>]*>/.exec(html)![0]).toContain("checked");
    expect(html).toMatch(/data-testid="motor\.use-file-label">Enabled</);
    expect(html).toMatch(/<select[^>]*data-testid="motor\.delay"/);
    expect(html).toContain("Thrust curve and timing from the motor file");
  });
});

describe("a ref the library does not have (R0.11)", () => {
  const GONE = "lib:motors/Gone.eng#C6";

  it("says motor not found and names the ref, never another motor", () => {
    const html = pageHtml(snapshot({ ...MOTORS, baseline: GONE }), "baseline", null);
    expect(html).not.toContain('data-testid="motor.detail"');
    expect(html).toMatch(/data-testid="motor\.missing"[^>]*data-motor="lib:motors\/Gone\.eng#C6"/);
    expect(html).toContain("Motor not found");
    expect(html).toContain(GONE);
  });

  it("does not call a motor missing before the project's motors have loaded", () => {
    const html = pageHtml(snapshot({ ...MOTORS, baseline: GONE }), "baseline", null, { library: { state: "ready", motors: LIBRARY, project: "loading" } });
    expect(html).not.toContain("Motor not found");
    expect(html).toContain("Loading the motor library");
  });

  it("does not call a motor missing when the project's motors could not be read", () => {
    const html = pageHtml(snapshot({ ...MOTORS, baseline: GONE }), "baseline", null, { library: { state: "ready", motors: LIBRARY, project: "error", projectError: "sidecar restarting" } });
    expect(html).not.toContain("Motor not found");
    expect(html).toContain("could not be read");
    expect(html).toContain("sidecar restarting");
  });

  it("a configuration with no motor still offers the first row to assign", () => {
    const snap = snapshot(MOTORS);
    (snap.evaluated as EvaluatedModel).configs["baseline"]!.motors = [];
    const html = pageHtml(snap, "baseline", null);
    expect(html).toMatch(/data-testid="motor\.detail" data-motor="generic:RW_A8G"/);
    expect(html).toMatch(/data-testid="motor\.assign" data-state="assign"/);
  });

  it("marks the assigned row when the config names the motor by bare designation", () => {
    const html = pageHtml(snapshot({ ...MOTORS, baseline: "RW_C6G" }), "baseline", null);
    expect(html).toMatch(/data-testid="motor\.detail" data-motor="generic:RW_C6G"/);
    expect(html).toMatch(/data-motor="generic:RW_C6G"[^>]*>(?:(?!data-testid="motors\.row").)*data-testid="motors\.assigned"/);
    expect(html).toMatch(/data-testid="motor\.assign" data-state="assigned"/);
  });
});

/** The value of `aria-describedby`'s target: the text the id points at. */
const describedBy = (html: string, control: string): string => {
  const ids = /aria-describedby="([^"]+)"/.exec(control)![1]!.split(" ");
  return ids.map((id) => new RegExp(`id="${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*>([^<]*)<`).exec(html)![1]).join(" ");
};

describe("the delay and recovery controls are found by what they show (D27)", () => {
  it("both Ejection delay controls carry the unit beside them", () => {
    const typed = pageHtml(withDelay(4), "baseline", null);
    const input = /<input[^>]*data-testid="motor\.delay"[^>]*>/.exec(typed)![0];
    expect(input).toContain('aria-label="Ejection delay"');
    expect(describedBy(typed, input)).toBe("s");

    const listed = pageHtml(withDelay(3), "baseline", null);
    const select = /<select[^>]*data-testid="motor\.delay"[^>]*>/.exec(listed)![0];
    expect(select).toContain('aria-label="Ejection delay"');
    expect(describedBy(listed, select)).toBe("s");
    // The unit is beside the select, not in every option.
    expect(listed).toMatch(/<option[^>]*>3\.0<\/option>/);
  });

  function recoveryHtml(event: string, altitude?: number): string {
    const snap = snapshot(MOTORS);
    const model = snap.evaluated as EvaluatedModel;
    const chute = model.components.find((c) => c.shape.type === "parachute")!.id;
    model.configs["baseline"]!.deployments = [{ component: chute, event, delay: 0, ...(altitude !== undefined ? { altitude } : {}) } as never];
    return pageHtml(snap, "baseline", null, { subtab: "Recovery" });
  }
  const headerId = (html: string, name: string) => new RegExp(`<th id="([^"]+)">${name}</th>`).exec(html)![1]!;

  it("names the event by the Deploys header and the row by its part", () => {
    const html = recoveryHtml("ejection", 200);
    const select = /<select[^>]*data-testid="recovery\.event"[^>]*>/.exec(html)![0];
    expect(select).toContain(`aria-labelledby="${headerId(html, "Deploys")}"`);
    expect(select).not.toContain("aria-label=");
    expect(html).toMatch(/<option[^>]*>Ejection<\/option>/);
    expect(html).toMatch(/data-testid="recovery\.row"[^>]*><td>[^<]+<\/td>/);
  });

  it("shows the altitude under Ejection, labelled as applying only to the Altitude event", () => {
    const html = recoveryHtml("ejection", 200);
    const input = /<input[^>]*data-testid="recovery\.altitude"[^>]*>/.exec(html)![0];
    expect(input).toContain('value="200"');
    expect(input).toContain(`aria-labelledby="${headerId(html, "Altitude")}"`);
    expect(describedBy(html, input)).toBe("m used by the Altitude event");
    expect(html).toContain("used by the Altitude event");
  });

  it("the Altitude event's field has the unit alone; other events show none", () => {
    const html = recoveryHtml("altitude", 150);
    const input = /<input[^>]*data-testid="recovery\.altitude"[^>]*>/.exec(html)![0];
    expect(describedBy(html, input)).toBe("m");
    expect(html).not.toContain("used by the Altitude event");
    expect(recoveryHtml("apogee")).not.toContain('data-testid="recovery.altitude"');
    expect(recoveryHtml("timer")).not.toContain('data-testid="recovery.altitude"');
  });
});
