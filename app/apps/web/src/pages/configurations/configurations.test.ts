/**
 * M2.10 page 03 units: configuration rows with the status derived from real
 * runs (Simulated, Outdated, Not simulated, Running), motor mounts and
 * filters, and the patch ops behind New / Duplicate / Rename / Delete /
 * Assign / deployment edits.
 */
import { readFileSync } from "node:fs";
import type { EvaluatedModel, HistoryStep, RunListOut, schema } from "@rw/contracts";
import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { buildCasing, CASING_PARTS, CASING_STAGE_LOOK, casingDims, casingPose } from "./casing3d.ts";
import { visibleTriangles } from "../../viewport/productStage.ts";
import { bakeStage, STAGE_LOOK } from "../../viewport/stage.ts";
import { niceTicks, thrustAreaPath } from "./MotorGraphics.tsx";
import {
  ALL,
  altitudeDisplay,
  altitudeSource,
  assignOps,
  configFieldOps,
  configFieldRemoveOps,
  configSourceLevel,
  delaySource,
  deployEventOps,
  configRows,
  configStatus,
  deleteOps,
  deployOps,
  duplicateOps,
  ejectionDelayState,
  filterMotors,
  filterOptions,
  fitsMount,
  motorMounts,
  motorRef,
  newConfigOps,
  nominalMount,
  renameOps,
  uniqueId,
} from "./model.ts";

const repo = new URL("../../../../../../", import.meta.url);
const fixture = <T,>(name: string): T => (JSON.parse(readFileSync(new URL(`fixtures/contracts/${name}.json`, repo), "utf8")) as { payload: T }).payload;
const evaluated = fixture<EvaluatedModel>("evaluated-model");

type Run = RunListOut["runs"][number];
const run = (sim: string, status: Run["status"], hash: string | null): Run => ({ sim, sim_name: sim, config: sim, kind: "flight", status, run_id: hash ? `r-${sim}` : null, model_hash: hash, provenance: "engineering" }) as Run;
const steps = [
  { seq: 1, ts: "2026-10-12T09:30:00Z", model_hash: "h1" },
  { seq: 2, ts: "2026-10-13T10:15:00Z", model_hash: "h2" },
] as HistoryStep[];

const curve = (id: string, cls: string, d: number, impulse: number, delays: number[] = [3, 5]): schema.ThrustCurve =>
  ({
    designation: id,
    manufacturer: "RocketWright",
    class: cls,
    diameter: d,
    length: 0.07,
    delays,
    prop_mass: 0.01,
    total_mass: 0.02,
    total_impulse: impulse,
    burn_time: 1,
    average_thrust: impulse,
    max_thrust: impulse * 3,
    points: [
      { t: 0, thrust: 0 },
      { t: 0.2, thrust: impulse * 3 },
      { t: 1, thrust: 0 },
    ],
    sha256: "0",
    source: { kind: "generic", id },
  }) as schema.ThrustCurve;
const MOTORS = [curve("RW_A8G", "A", 0.018, 2.4), curve("RW_B4G", "B", 0.018, 4.8), curve("RW_D10G", "D", 0.024, 19)];

describe("configuration rows", () => {
  it("derives Simulated / Outdated / Not simulated from the runs of each configuration's sims", () => {
    const hash = evaluated.model_hash;
    const runs = [run("baseline", "complete", hash), run("fin_revision", "outdated", "h2"), run("higher_altitude", "outdated", "h1")];
    const rows = configRows(evaluated, runs, [...steps, { seq: 3, ts: "2026-10-15T14:04:00Z", model_hash: hash } as HistoryStep]);
    expect(rows.map((r) => r.id)).toEqual(["baseline", "higher_altitude", "recovery_test"]);
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(by["baseline"]!.sims.sort()).toEqual(["baseline", "fin_revision"]);
    expect(by["baseline"]!.status).toMatchObject({ kind: "simulated", label: "Simulated · Oct 15, 2026" });
    expect(by["higher_altitude"]!.status).toMatchObject({ kind: "outdated", label: "Outdated · Oct 12, 2026" });
    expect(by["higher_altitude"]!.status.view.tone).toBe("amber");
    expect(by["recovery_test"]!.status).toMatchObject({ kind: "not_simulated", label: "Not simulated" });
    expect(by["baseline"]!.motor).not.toMatch(/^generic:/);
  });

  it("shows Running while a job flies a configuration", () => {
    const s = configStatus(["baseline"], [run("baseline", "running", null)], "h", steps, [{ job_id: "j", kind: "simulate", state: "running", progress: 0.2, sim: "baseline" }]);
    expect(s.kind).toBe("running");
  });
});

describe("motors", () => {
  it("finds the motor mounts and the standard motor size they take", () => {
    const mounts = motorMounts(evaluated);
    expect(mounts.map((m) => m.id)).toEqual(["motor_mount"]);
    expect(nominalMount(0.019)).toBe(0.018);
    expect(nominalMount(0.0245)).toBe(0.024);
    const m18 = { ...mounts[0]!, diameter: 0.019, nominal: 0.018, length: 0.11 };
    expect(fitsMount(MOTORS[0]!, m18)).toBe(true);
    expect(fitsMount(MOTORS[2]!, m18)).toBe(false);
  });

  it("filters by search text, diameter, manufacturer, and impulse class (All by default)", () => {
    const opts = filterOptions(MOTORS);
    expect(opts.diameter).toEqual([ALL, "18 mm", "24 mm"]);
    expect(opts.manufacturer).toEqual([ALL, "Generic"]);
    expect(opts.impulseClass).toEqual([ALL, "A", "B", "D"]);
    const f = { query: "", diameter: ALL, manufacturer: ALL, impulseClass: ALL };
    expect(filterMotors(MOTORS, f)).toHaveLength(3);
    expect(filterMotors(MOTORS, { ...f, diameter: "18 mm" }).map((m) => m.designation)).toEqual(["RW_A8G", "RW_B4G"]);
    expect(filterMotors(MOTORS, { ...f, query: "b4" }).map((m) => m.designation)).toEqual(["RW_B4G"]);
    expect(filterMotors(MOTORS, { ...f, impulseClass: "D" }).map(motorRef)).toEqual(["generic:RW_D10G"]);
  });

  it("picks round axis ticks", () => {
    expect(niceTicks(12)).toEqual([0, 2.5, 5, 7.5, 10, 12.5]);
    expect(niceTicks(1.2, 5)).toEqual([0, 0.25, 0.5, 0.75, 1, 1.25]);
  });
});

describe("patch ops", () => {
  it("makes unique ids", () => {
    expect(uniqueId("Higher altitude", ["higher_altitude"])).toBe("higher_altitude_2");
    expect(uniqueId("  ", [])).toBe("config");
  });

  it("duplicates a configuration with a linked sim", () => {
    const { id, ops } = duplicateOps(evaluated, "baseline", "Baseline (copy)");
    expect(id).toBe("baseline_copy");
    expect(ops[0]).toEqual({ op: "copy", from: "/configs/baseline", path: "/configs/baseline_copy" });
    expect(ops).toContainEqual({ op: "replace", path: "/sims/baseline_copy/config", value: "baseline_copy" });
  });

  it("creates a new configuration with a fitting motor, the main chute at ejection, and a sim", () => {
    const { id, ops } = newConfigOps(evaluated, MOTORS);
    expect(id).toBe("new_configuration");
    const add = ops[0] as { op: string; value: { motors: Record<string, { motor: string; delay: string }>; deploy: Record<string, { event: string }> } };
    expect(add.op).toBe("add");
    expect(Object.keys(add.value.motors)).toEqual(["motor_mount"]);
    expect(add.value.deploy["parachute"]).toEqual({ event: "ejection" });
    expect(ops.some((o) => o.path === `/sims/${id}`)).toBe(true);
  });

  it("renames (with a same-named sim), deletes with its sims, assigns, and sets deployment", () => {
    expect(renameOps("baseline", "Base", ["baseline"], evaluated)).toEqual([
      { op: "replace", path: "/configs/baseline/name", value: "Base" },
      { op: "replace", path: "/sims/baseline/name", value: "Base" },
    ]);
    expect(deleteOps("baseline", ["baseline", "fin_revision"])).toEqual([
      { op: "remove", path: "/configs/baseline" },
      { op: "remove", path: "/sims/baseline" },
      { op: "remove", path: "/sims/fin_revision" },
    ]);
    expect(assignOps("baseline", "motor_mount", MOTORS[1]!, 5, true)).toEqual([
      { op: "replace", path: "/configs/baseline/motors/motor_mount/motor", value: "generic:RW_B4G" },
      { op: "add", path: "/configs/baseline/motors/motor_mount/delay", value: "5 s" },
    ]);
    expect(assignOps("x", "m", MOTORS[0]!, null, false)).toEqual([{ op: "add", path: "/configs/x/motors/m", value: { motor: "generic:RW_A8G" } }]);
    expect(deployOps("baseline", "chute", "apogee", true)).toEqual([{ op: "replace", path: "/configs/baseline/deploy/chute/event", value: "apogee" }]);
  });
});

describe("recovery and stage edits (files-aware ops)", () => {
  const files = {
    "configs/a.rw.toml": 'name = "A"\n[motors.mmt]\nmotor = "generic:RW_C6G"\n\n[deploy.chute]\nevent = "ejection"\ndelay = "1 s"\n',
    "configs/b.rw.toml": 'name = "B"\n[deploy]\nchute = { event = "apogee" }\n',
    "configs/c.rw.toml": 'name = "C"\n[motors.mmt]\nmotor = "generic:RW_C6G"\n',
  };

  it("finds what the source holds", () => {
    expect(configSourceLevel(files, "a", "deploy", "chute")).toBe("entry");
    expect(configSourceLevel(files, "a", "deploy", "streamer")).toBe("table");
    expect(configSourceLevel(files, "b", "deploy", "chute")).toBe("entry");
    expect(configSourceLevel(files, "c", "deploy", "chute")).toBe("none");
    expect(configSourceLevel(files, "c", "stages", "booster")).toBe("none");
    expect(configSourceLevel(files, "missing", "deploy", "chute")).toBe("none");
  });

  it("sets a field in place, adds the entry, or adds the table", () => {
    expect(configFieldOps(files, "a", "deploy", "chute", "altitude", "150 m", { event: "altitude" })).toEqual([{ op: "add", path: "/configs/a/deploy/chute/altitude", value: "150 m" }]);
    expect(configFieldOps(files, "a", "deploy", "streamer", "delay", "2 s", { event: "timer" })).toEqual([{ op: "add", path: "/configs/a/deploy/streamer", value: { event: "timer", delay: "2 s" } }]);
    expect(configFieldOps(files, "c", "stages", "booster", "separation", "burnout")).toEqual([{ op: "add", path: "/configs/c/stages", value: { booster: { separation: "burnout" } } }]);
    expect(deployEventOps(files, "c", "chute", "altitude")).toEqual([{ op: "add", path: "/configs/c/deploy", value: { chute: { event: "altitude" } } }]);
  });

  it("removes a field only when the source sets it", () => {
    expect(configFieldRemoveOps(files, "a", "deploy", "chute", "delay")).toEqual([{ op: "remove", path: "/configs/a/deploy/chute/delay" }]);
    expect(configFieldRemoveOps(files, "a", "deploy", "chute", "altitude")).toEqual([]);
    expect(configFieldRemoveOps(files, "c", "deploy", "chute", "delay")).toEqual([]);
  });

  it("parses altitudes and delays with units and limits", () => {
    expect(altitudeSource("150", "mm")).toEqual({ value: "150 m" });
    expect(altitudeSource("500", "in")).toEqual({ value: "500 ft" });
    expect(altitudeSource("0", "m")).toHaveProperty("error");
    expect(altitudeSource("x", "m")).toHaveProperty("error");
    expect(altitudeDisplay(152.4, "in")).toBe("500");
    expect(altitudeDisplay(150, "cm")).toBe("150");
    expect(delaySource("1.5")).toEqual({ value: "1.5 s" });
    expect(delaySource("-1")).toHaveProperty("error");
    expect(delaySource("")).toHaveProperty("error");
  });

  it("derives the ejection delay's source from the motor file's listed delays (R20-03)", () => {
    // The seeded Baseline: RW_B4G lists 2, 4, 6 s and the configuration sets 3 s, a custom delay.
    expect(ejectionDelayState(3, [6, 2, 4])).toEqual({ source: "custom", listed: [2, 4, 6], nearest: 2 });
    expect(ejectionDelayState(4, [2, 4, 6])).toEqual({ source: "manufacturer", listed: [2, 4, 6], nearest: 4 });
    expect(ejectionDelayState(5.5, [2, 4, 6]).nearest).toBe(6);
    // Unset: the file's timing (its first listed delay) when it lists any.
    expect(ejectionDelayState(null, [3, 5])).toEqual({ source: "manufacturer", listed: [3, 5], nearest: 3 });
    expect(ejectionDelayState(null, [])).toEqual({ source: "custom", listed: [], nearest: null });
    // The user chose to type a delay: custom even on a listed value.
    expect(ejectionDelayState(4, [2, 4, 6], true).source).toBe("custom");
  });
});

describe("thrust curve area (R20-03)", () => {
  it("closes the curve down to the zero-thrust baseline", () => {
    const pts = [
      { t: 0, thrust: 0 },
      { t: 0.5, thrust: 10 },
      { t: 1, thrust: 0 },
    ];
    // x: 10 px per 0.1 s; y: baseline at 100, 5 px per N up.
    const d = thrustAreaPath(pts, (t) => t * 100, (f) => 100 - 5 * f);
    expect(d).toBe("M0.0,100.0 L50.0,50.0 L100.0,100.0 L100.0,100.0 L0.0,100.0 Z");
    expect(thrustAreaPath(pts.slice(0, 1), (t) => t, (f) => f)).toBe("");
  });
});

describe("motor casing render (FID-03-05)", () => {
  it("builds the sealed casing at the motor's proportions: case, end cap, retainer, stepped nozzle", () => {
    const m = buildCasing(0.07, 0.018, "realistic");
    try {
      expect(Object.keys(m.parts).sort()).toEqual([...CASING_PARTS].sort());
      for (const p of CASING_PARTS) expect(m.parts[p], p).toBeGreaterThan(0);
      const size = new THREE.Box3().setFromObject(m.group).getSize(new THREE.Vector3());
      // Length along +X: the case plus the cap dome and the nozzle proud of the retainer.
      expect(size.x).toBeGreaterThan(0.07);
      expect(size.x).toBeLessThan(0.07 * 1.12);
      // The retainer flange is the widest part, a little proud of the 18 mm case.
      expect(size.y).toBeGreaterThan(0.018);
      expect(size.y).toBeLessThan(0.018 * 1.1);
      // The nozzle steps down twice from the closure ring to the throat.
      const insert = m.group.getObjectByName("casing-nozzle-insert") as THREE.Mesh;
      expect(insert).toBeDefined();
    } finally {
      m.dispose();
    }
  });

  it("keeps a drawable aspect, and the flat style shares the shapes", () => {
    expect(casingDims(0, 0.018)).toEqual({ length: 0.072, radius: 0.009 });
    expect(casingDims(0.01, 0.018).length).toBeCloseTo(0.027, 9);
    const flat = buildCasing(0.07, 0.018, "flat");
    expect(Object.keys(flat.parts).sort()).toEqual([...CASING_PARTS].sort());
    flat.dispose();
  });

  it("frames each toolbar view with a level camera; Iso lies on a diagonal", () => {
    for (const v of ["iso", "top", "side", "front", "rear"]) expect(casingPose(v).shot.axisTiltDeg).toBeNull();
    expect(casingPose("iso").yaw).toBeGreaterThan(0);
    expect(casingPose("side").yaw).toBe(0);
  });

  it("rests on a grounded contact shadow: a darker, tighter core than the assembly floor (R19-03)", () => {
    const m = buildCasing(0.07, 0.018, "realistic", 32);
    m.group.updateMatrixWorld(true);
    const tris = visibleTriangles(m.group);
    const floorY = -0.009;
    const stats = (look: typeof STAGE_LOOK) => {
      const bake = bakeStage(tris, floorY, 0.009, look)!;
      const cell = bake.grid.cell * bake.grid.cell;
      let peak = 0;
      let area = 0;
      for (const a of bake.shadow) {
        peak = Math.max(peak, a);
        if (a > 0.15) area += cell;
      }
      return { peak, area };
    };
    const casing = stats(CASING_STAGE_LOOK);
    const studio = stats(STAGE_LOOK);
    expect(casing.peak).toBeGreaterThan(0.85);
    expect(casing.peak).toBeGreaterThan(studio.peak);
    expect(casing.area).toBeLessThan(studio.area);
    m.dispose();
  });
});

