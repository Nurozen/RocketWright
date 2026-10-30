/**
 * M5.3 page 06 Visual flow units: the study list from the project's sims,
 * the visual.json URL, the transport (play, speed, seek, end), the trace
 * geometry and cursor, and the provenance label bound to the record.
 */
import { describe, expect, it } from "vitest";
import { orderStudies } from "./layers.tsx";
import { provenanceLabel } from "./model.ts";
import { PLOT, tracePath, xOf, yOf } from "./traces.tsx";
import { clockOf, createTransport } from "./transport.tsx";
import { studyRows, visualRunUrl } from "./visual.tsx";

describe("studies", () => {
  it("lists the visual flow sims only, numbered studies first", () => {
    const rows = studyRows({
      baseline: { name: "Baseline", kind: "flight" },
      tank_motion: { name: "Tank motion", kind: "visual_flow" },
      flow_overview: { name: "Flow overview", kind: "visual_flow" },
      study_01: { name: "Study 01", kind: "visual_flow" },
    });
    expect(rows.map((r) => r.name)).toEqual(["Study 01", "Flow overview", "Tank motion"]);
    expect(orderStudies([{ id: "b", name: "Study 10" }, { id: "a", name: "Study 2" }]).map((r) => r.id)).toEqual(["a", "b"]);
  });
  it("fetches the study's visual.json beside its manifest", () => {
    expect(visualRunUrl("http://127.0.0.1:9/", "p 1", "study_01", "7d0fcfd5d690")).toBe("http://127.0.0.1:9/api/projects/p%201/runs/study_01/7d0fcfd5d690/visual.json");
  });
  it("labels the record's provenance, never assuming it", () => {
    expect(provenanceLabel("visual")).toBe("Visual model · Not an engineering result");
    expect(provenanceLabel("engineering")).toBe("Engineering result");
  });
});

describe("transport", () => {
  it("plays at the chosen speed, stops at the end, and replays from the start", () => {
    const t = createTransport(10);
    const s = () => t.getState();
    s().tick(1);
    expect(s().t).toBe(0); // paused
    s().play();
    s().tick(1);
    expect(s().t).toBeCloseTo(1, 9);
    s().setSpeed(2);
    s().tick(1);
    expect(s().t).toBeCloseTo(3, 9);
    s().setSpeed(0.5);
    s().tick(2);
    expect(s().t).toBeCloseTo(4, 9);
    s().tick(100);
    expect(s().t).toBe(10);
    expect(s().playing).toBe(false);
    const seek = s().seekId;
    s().play();
    expect(s().t).toBe(0);
    expect(s().seekId).toBe(seek + 1);
  });
  it("bumps the seek id on every scrub, so the liquid re-settles", () => {
    const t = createTransport(10);
    const clock = clockOf(t);
    const a = clock.seekId();
    t.getState().seek(4.2);
    expect(clock.time()).toBeCloseTo(4.2, 9);
    expect(clock.seekId()).toBe(a + 1);
    t.getState().seek(-3);
    expect(clock.time()).toBe(0);
  });
});

describe("traces", () => {
  it("maps normalized time and value into the plot box", () => {
    expect(xOf(0)).toBe(PLOT.left);
    expect(xOf(1)).toBe(PLOT.w - PLOT.right);
    expect(yOf(1)).toBe(PLOT.top);
    expect(yOf(0)).toBe(PLOT.h - PLOT.bottom);
    expect(tracePath([
      [0, 1],
      [1, 0],
    ])).toBe(`M${xOf(0).toFixed(2)},${yOf(1).toFixed(2)}L${xOf(1).toFixed(2)},${yOf(0).toFixed(2)}`);
  });
});
