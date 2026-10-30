/** M1.51 plots: series CSV, event markers, Canvas2D event lines, and plot helpers (`pnpm --filter web test plots`). */
import { describe, expect, it } from "vitest";
import { drawEventLines, laneHeight, laneOf, mergeShared, type Ctx2D, type DrawnEvent } from "./eventLines.ts";
import { eventMarkers, plotEventMarkers, type EventRun, type FlightEvent, type RunSummary } from "./events.ts";
import { fmtNum, isPlotTab, legendFigure, PLOT_TABS } from "./quantities.ts";
import { parseSeriesCsv, seriesColumn, seriesToCsv } from "./series.ts";
import { alignLines, yFloor } from "./TimePlot.tsx";

const SUMMARY: RunSummary = {
  schema: "rw/1",
  apogee_m: 612.4,
  max_velocity_ms: 118.6,
  max_accel_ms2: 61.2,
  max_mach: 0.349,
  time_to_apogee_s: 10.84,
  flight_time_s: 62.3,
  landing_velocity_ms: 4.92,
  rail_exit_velocity_ms: 17.8,
  min_stability_cal: 1.62,
  burnout_time_s: 2.0,
  burnout_altitude_m: 104.7,
  landing_x_m: 0,
  landing_y_m: 0,
  drift_m: 0,
};

describe("series.csv", () => {
  const csv = "t,altitude,x,y,vz,speed,custom\n0,0,0,0,0,0,1\n0.5,10,0,0,20,20,1\n0.73,14,0,0,18,18,\n1,18,0.1,0,16,16,1\n1.5,24,0.2,0,12,12,1\n";

  it("parses columns with their dimensions and infers dt from the grid (event rows are off-grid)", () => {
    const s = parseSeriesCsv(csv);
    expect(s.columns.map((c) => [c.name, c.dim])).toEqual([
      ["t", "time"],
      ["altitude", "length"],
      ["x", "length"],
      ["y", "length"],
      ["vz", "velocity"],
      ["speed", "velocity"],
      ["custom", "dimensionless"],
    ]);
    expect(s.dt).toBe(0.5);
    expect(s.rows).toHaveLength(5);
    expect(seriesColumn(s, "altitude")).toEqual([0, 10, 14, 18, 24]);
    expect(Number.isNaN(seriesColumn(s, "custom")![2]!)).toBe(true);
    expect(seriesColumn(s, "mach")).toBeNull();
  });

  it("round-trips through seriesToCsv", () => {
    const s = parseSeriesCsv(csv);
    expect(parseSeriesCsv(seriesToCsv(s))).toEqual(s);
  });

  it("rejects malformed files", () => {
    expect(() => parseSeriesCsv("")).toThrow(/empty/);
    expect(() => parseSeriesCsv("altitude,t\n0,0\n")).toThrow(/first column must be t/);
    expect(() => parseSeriesCsv("t,altitude\n0\n")).toThrow(/1 cells, expected 2/);
  });
});

/** A run's events: burnout, apogee, a drogue then a main deployment, landing. */
const EVENTS: FlightEvent[] = [
  { t: 1.6, kind: "burnout", altitude: 90, velocity: 120 },
  { t: 11.2, kind: "apogee", altitude: 640, velocity: 0 },
  { t: 11.3, kind: "deployment", altitude: 640, velocity: 2 },
  { t: 38.4, kind: "deployment", altitude: 150, velocity: 18 },
  { t: 64, kind: "landing", altitude: 0, velocity: 5 },
];

describe("event markers", () => {
  it("uses the run's events: Recovery is the last deployment (main chute), not the landing", () => {
    expect(eventMarkers(SUMMARY, EVENTS)).toEqual([
      { label: "Burnout", t: 1.6 },
      { label: "Apogee", t: 11.2 },
      { label: "Recovery", t: 38.4 },
    ]);
  });

  it("never marks touchdown as Recovery: no deployment event (or no events) means no Recovery line", () => {
    expect(eventMarkers(SUMMARY, EVENTS.filter((e) => e.kind !== "deployment"))).toEqual([
      { label: "Burnout", t: 1.6 },
      { label: "Apogee", t: 11.2 },
    ]);
    // Without events the summary gives Burnout and Apogee only.
    expect(eventMarkers(SUMMARY)).toEqual([
      { label: "Burnout", t: 2.0 },
      { label: "Apogee", t: 10.84 },
    ]);
  });

  it("drops missing or invalid times", () => {
    expect(eventMarkers(null)).toEqual([]);
    expect(eventMarkers({ ...SUMMARY, burnout_time_s: Number.NaN }, EVENTS.slice(1))).toHaveLength(2);
  });
});

/** Records Canvas2D calls. */
function fakeCtx(): Ctx2D & { calls: string[] } {
  const calls: string[] = [];
  const ctx = {
    calls,
    strokeStyle: "",
    fillStyle: "",
    lineWidth: 1,
    font: "",
    textBaseline: "alphabetic",
    textAlign: "start",
    save: () => calls.push("save"),
    restore: () => calls.push("restore"),
    beginPath: () => calls.push("beginPath"),
    moveTo: (x: number, y: number) => calls.push(`moveTo ${x} ${y}`),
    lineTo: (x: number, y: number) => calls.push(`lineTo ${x} ${y}`),
    stroke: () => calls.push(`stroke ${String(ctx.strokeStyle)}`),
    fillText: (t: string, x: number, y: number) => calls.push(`fillText ${t} ${x} ${y}`),
    setLineDash: (s: number[]) => calls.push(`dash ${s.join(",")}`),
    measureText: (t: string) => ({ width: t.length * 7 }),
  };
  return ctx as unknown as Ctx2D & { calls: string[] };
}

const STYLE = { stroke: "#8e989c", text: "#e6e9ea", pxRatio: 1, font: "12px Inter" };

/** Label boxes as drawn: `[left, top, right, bottom]` (4 px gap, 16 px rows). */
function labelBoxes(placed: DrawnEvent[], width: (s: string) => number): [number, number, number, number][] {
  return placed
    .filter((p) => p.labelTop !== null)
    .map((p) => {
      const [a, b] = p.flip ? [p.x - 4 - width(p.label), p.x] : [p.x, p.x + 4 + width(p.label)];
      return [a, p.labelTop!, b, p.labelTop! + 16];
    });
}

describe("event lines (Canvas2D)", () => {
  const box = { left: 50, top: 60, width: 500, height: 300 };
  const toX = (t: number) => box.left + t * 5;
  const width = (s: string) => s.length * 7;

  it("draws one dashed line per in-range event, labels in a lane above the plot area", () => {
    const ctx = fakeCtx();
    const placed = drawEventLines(ctx, eventMarkers(SUMMARY, EVENTS), (t) => box.left + t * 10, box, STYLE);
    expect(placed.map((p) => [p.label, p.x, p.row])).toEqual([
      ["Burnout", 66.5, 0],
      ["Apogee", 162.5, 0],
      ["Recovery", 434.5, 0],
    ]);
    expect(ctx.calls).toContain("dash 4,4");
    // One lane row: labels at 60 - 4 - 16 = 40, lines from under the label (56) to the plot bottom.
    expect(placed.every((p) => p.labelTop === 40 && p.lineTop === 56 && p.plotTop === 60)).toBe(true);
    expect(ctx.calls.filter((c) => c.startsWith("moveTo"))).toEqual(["moveTo 66.5 56", "moveTo 162.5 56", "moveTo 434.5 56"]);
    expect(ctx.calls.filter((c) => c.startsWith("lineTo"))).toEqual(["lineTo 66.5 360", "lineTo 162.5 360", "lineTo 434.5 360"]);
    expect(ctx.calls.filter((c) => c.startsWith("fillText"))).toEqual(["fillText Burnout 70.5 42", "fillText Apogee 166.5 42", "fillText Recovery 438.5 42"]);
    // Every label box ends above the plot area, so no label covers a curve.
    for (const [, , , bottom] of labelBoxes(placed, width)) expect(bottom).toBeLessThanOrEqual(box.top);
    expect(ctx.calls[0]).toBe("save");
    expect(ctx.calls.at(-1)).toBe("restore");
  });

  it("drops events outside the x range and staggers labels that would overlap onto lower lane rows", () => {
    const ctx = fakeCtx();
    const placed = drawEventLines(
      ctx,
      [
        { label: "Burnout", t: 2 },
        { label: "Apogee", t: 4 },
        { label: "Recovery", t: 500 },
      ],
      toX,
      box,
      STYLE,
    );
    expect(placed.map((p) => [p.label, p.row])).toEqual([
      ["Burnout", 0],
      ["Apogee", 1],
    ]);
    // Two rows: row 0 at 60 - 4 - 32, row 1 just above the plot.
    expect(placed.map((p) => p.labelTop)).toEqual([24, 40]);
    expect(laneOf(placed)).toEqual({ rows: 2, free: 0 });
    expect(laneHeight(laneOf(placed))).toBe(36);
    expect(laneHeight({ rows: 0, free: 0 })).toBe(0);
  });

  it("flips a label that would cross the right edge to the left of its line", () => {
    const ctx = fakeCtx();
    const placed = drawEventLines(ctx, [{ label: "Recovery", t: 98 }], toX, box, STYLE);
    expect(placed).toEqual([{ label: "Recovery", t: 98, x: 540.5, row: 0, flip: true, labelled: true, runs: [], labelTop: 40, lineTop: 56, plotTop: 60, mark: "line" }]);
    expect(ctx.calls).toContain("fillText Recovery 536.5 42");
  });

  it("draws one labelled marker per event and each run's own times as ticks in the run's colour", () => {
    const ctx = fakeCtx();
    const a = eventMarkers(SUMMARY, EVENTS).map((m) => ({ ...m, run: "baseline", color: "#61b5ad" }));
    // Run B: burnout 0.5 s later, apogee 14 s later, recovery far away.
    const b = [
      { label: "Burnout" as const, t: 2.1, run: "higher", color: "#f1ae6e" },
      { label: "Apogee" as const, t: 25, run: "higher", color: "#f1ae6e" },
      { label: "Recovery" as const, t: 90, run: "higher", color: "#f1ae6e" },
    ];
    const placed = drawEventLines(ctx, [...a, ...b], toX, box, STYLE);
    expect(placed).toHaveLength(6);
    // Three labels, one per event name; three dashed neutral markers, one per name.
    const labels = ctx.calls.filter((c) => c.startsWith("fillText")).map((c) => c.split(" ")[1]);
    expect(labels.sort()).toEqual(["Apogee", "Burnout", "Recovery"]);
    expect(placed.filter((p) => p.mark === "line").map((p) => p.label).sort()).toEqual(["Apogee", "Burnout", "Recovery"]);
    // Strokes: three neutral markers, then a tick per run per event in the run's colour.
    expect(ctx.calls.filter((c) => c.startsWith("stroke")).sort()).toEqual([
      "stroke #61b5ad",
      "stroke #61b5ad",
      "stroke #61b5ad",
      "stroke #8e989c",
      "stroke #8e989c",
      "stroke #8e989c",
      "stroke #f1ae6e",
      "stroke #f1ae6e",
      "stroke #f1ae6e",
    ]);
    // A tick-only position stands on the time axis, 7 px tall, never in the label lane.
    const burnoutB = placed.find((p) => p.label === "Burnout" && p.run === "higher")!;
    expect([burnoutB.labelled, burnoutB.mark, burnoutB.lineTop]).toEqual([false, "tick", 360 - 7]);
    expect(ctx.calls).toContain(`moveTo ${burnoutB.x} 360`);
    expect(ctx.calls).toContain(`lineTo ${burnoutB.x} 353`);
  });

  it("keeps a single run's markers in its colour with no ticks", () => {
    const ctx = fakeCtx();
    const placed = drawEventLines(ctx, eventMarkers(SUMMARY, EVENTS).map((m) => ({ ...m, run: "baseline", color: "#61b5ad" })), toX, box, STYLE);
    expect(placed.every((p) => p.mark === "line" && p.labelled)).toBe(true);
    expect(ctx.calls.filter((c) => c.startsWith("stroke"))).toEqual(["stroke #61b5ad", "stroke #61b5ad", "stroke #61b5ad"]);
  });

  it("deduplicates runs' lines whose events share a time within 0.2 s into one neutral line", () => {
    const ctx = fakeCtx();
    const markers = [
      { label: "Burnout" as const, t: 1.2, run: "a", color: "#61b5ad" },
      { label: "Burnout" as const, t: 1.35, run: "b", color: "#f1ae6e" },
      { label: "Apogee" as const, t: 3.3, run: "a", color: "#61b5ad" },
      { label: "Apogee" as const, t: 5.3, run: "b", color: "#f1ae6e" },
    ];
    expect(mergeShared(markers)).toEqual([
      { label: "Apogee", t: 3.3, run: "a", color: "#61b5ad", runs: ["a"] },
      { label: "Apogee", t: 5.3, run: "b", color: "#f1ae6e", runs: ["b"] },
      { label: "Burnout", t: 1.2, run: "a", runs: ["a", "b"] },
    ]);
    const placed = drawEventLines(ctx, markers, toX, box, STYLE);
    expect(placed.map((p) => [p.label, p.runs.join("+"), p.color ?? "neutral", p.mark])).toEqual([
      ["Burnout", "a+b", "neutral", "line"],
      ["Apogee", "a", "#61b5ad", "line"],
      ["Apogee", "b", "#f1ae6e", "tick"],
    ]);
    // Two neutral markers; ticks: the shared Burnout's two runs stacked, and each run's Apogee.
    expect(ctx.calls.filter((c) => c.startsWith("stroke")).sort()).toEqual([
      "stroke #61b5ad",
      "stroke #61b5ad",
      "stroke #8e989c",
      "stroke #8e989c",
      "stroke #f1ae6e",
      "stroke #f1ae6e",
    ]);
    // 0.2 s is inclusive; further apart stays two lines; one run's own events never merge.
    expect(mergeShared([{ label: "Apogee", t: 1, run: "a" }, { label: "Apogee", t: 1.2, run: "b" }])).toHaveLength(1);
    expect(mergeShared([{ label: "Apogee", t: 1, run: "a" }, { label: "Apogee", t: 1.25, run: "b" }])).toHaveLength(2);
    expect(mergeShared([{ label: "Apogee", t: 1, run: "a" }, { label: "Apogee", t: 1.1, run: "a" }])).toHaveLength(2);
  });

  it("tries the group's other line before a lower row (a shared label may sit on the second run's line)", () => {
    // Burnout [70.5, 123.5] and Apogee [116.5, 162.5] need two rows. Recovery on run a's line (130.5)
    // fits row 0, but that line would run through Apogee's label; on run b's line (165.5) it clears it.
    const markers = [
      { label: "Burnout" as const, t: 4, run: "a" },
      { label: "Apogee" as const, t: 13.3, run: "a" },
      { label: "Recovery" as const, t: 16, run: "a" },
      { label: "Recovery" as const, t: 23, run: "b" },
    ];
    const placed = drawEventLines(fakeCtx(), markers, (t) => box.left + t * 5, box, STYLE);
    const rec = placed.filter((p) => p.label === "Recovery");
    expect(rec.map((p) => [p.labelled, p.row])).toEqual([
      [false, 0],
      [true, 0],
    ]);
    expect(laneOf(placed).rows).toBe(2);
  });

  it("keeps upper-row labels clear of the legend and drops a label under it when nothing else fits", () => {
    const legend: [number, number][] = [[400, 550]];
    // Apogee at 210.5 fits beside the legend; Recovery at 470.5 sits inside the legend's span.
    const placed = drawEventLines(
      fakeCtx(),
      [
        { label: "Apogee", t: 32 },
        { label: "Recovery", t: 84 },
      ],
      toX,
      box,
      STYLE,
      legend,
    );
    expect(placed.map((p) => [p.label, p.row, p.underLegend ?? false])).toEqual([
      ["Apogee", 0, false],
      ["Recovery", 1, true],
    ]);
    expect(laneOf(placed)).toEqual({ rows: 2, free: 1 });
    // The plot top clears a 40 px legend plus the free row: max(2 * 16, 40 + 16) + 4.
    expect(laneHeight(laneOf(placed), 40)).toBe(60);
    // Without a legend, everything shares the top row.
    expect(drawEventLines(fakeCtx(), [{ label: "Recovery", t: 84 }], toX, box, STYLE).map((p) => p.row)).toEqual([0]);
  });

  it("never overlaps two labels, nor a label and another label's line, however close the events are", () => {
    const markers = [
      { label: "Burnout" as const, t: 1, run: "a" },
      { label: "Apogee" as const, t: 1.5, run: "a" },
      { label: "Burnout" as const, t: 3, run: "b" },
      { label: "Apogee" as const, t: 3.6, run: "b" },
      { label: "Recovery" as const, t: 4, run: "a" },
      { label: "Recovery" as const, t: 99, run: "b" },
    ];
    const placed = drawEventLines(fakeCtx(), markers, toX, box, STYLE);
    const boxes = labelBoxes(placed, width);
    for (const [i, p] of boxes.entries()) {
      for (const q of boxes.slice(i + 1)) {
        const apart = p[2] <= q[0] || q[2] <= p[0] || p[3] <= q[1] || q[3] <= p[1];
        expect(apart, JSON.stringify([p, q])).toBe(true);
      }
    }
    // No line runs through a label it does not own.
    for (const e of placed) {
      for (const [k, bx] of boxes.entries()) {
        const owner = placed.filter((p) => p.labelTop !== null)[k]!;
        if (owner === e) continue;
        const crosses = e.x > bx[0] && e.x < bx[2] && e.lineTop < bx[3];
        expect(crosses, `${e.label}/${e.run} through ${owner.label}/${owner.run}`).toBe(false);
      }
      if (e.mark === "line") expect(e.lineTop).toBeLessThanOrEqual(box.top);
      else expect(e.lineTop).toBeGreaterThan(box.top + box.height - 20);
    }
    // Every run's event is kept (marker or tick); one label per event name.
    expect(placed).toHaveLength(6);
    expect(placed.filter((p) => p.labelled)).toHaveLength(3);
  });
});

describe("event lines of compared runs", () => {
  const box = { left: 50, top: 60, width: 500, height: 300 };
  const toX = (t: number) => box.left + t * 5;
  // Two runs with different event times (Baseline burns out and peaks earlier), and a third that is not plotted.
  const runs: EventRun[] = [
    { id: "baseline", name: "Baseline", color: "#61b5ad", summary: SUMMARY, events: EVENTS },
    { id: "higher", name: "Higher altitude", color: "#f1ae6e", summary: { ...SUMMARY, burnout_time_s: 2.6, time_to_apogee_s: 24.5 }, events: null },
    { id: "fin", name: "Fin revision", color: "#9aa4a8", summary: { ...SUMMARY, burnout_time_s: 1.1 }, events: null },
  ];

  /** Draws the plot's event markers and checks every drawn line against the plotted series lines. */
  function drawnAgainst(plotted: string[], preferred: string | null) {
    const { run, markers } = plotEventMarkers(runs, plotted, preferred);
    const ctx = fakeCtx();
    const drawn = drawEventLines(ctx, markers, toX, box, STYLE);
    const series = runs.filter((r) => plotted.includes(r.id));
    for (const e of drawn) {
      // The line's run is plotted, and the line carries that run's colour (never neutral, never another run's).
      const owner = series.find((r) => r.id === e.run);
      expect(owner, `${e.label} at ${e.t}`).toBeDefined();
      expect(e.color).toBe(owner!.color);
      expect(e.run).toBe(run!.id);
      expect([e.mark, e.labelled]).toEqual(["line", true]);
      // Its time is that run's own event time.
      expect(eventMarkers(owner!.summary, owner!.events).find((m) => m.label === e.label)?.t).toBe(e.t);
    }
    // Every stroke is in the run's colour: no neutral marker, no other run's tick.
    const strokes = ctx.calls.filter((c) => c.startsWith("stroke"));
    expect(strokes.length).toBe(drawn.length);
    expect(new Set(strokes)).toEqual(new Set(run ? [`stroke ${run.color}`] : []));
    return { run, drawn };
  }

  it("draws only the selected run's events, in its series colour, when two runs are compared", () => {
    const { run, drawn } = drawnAgainst(["baseline", "higher"], "baseline");
    expect(run?.name).toBe("Baseline");
    expect(drawn.map((e) => [e.label, e.t])).toEqual([
      ["Burnout", 1.6],
      ["Apogee", 11.2],
      ["Recovery", 38.4],
    ]);
  });

  it("follows the selection to the other plotted run, never mixing the two runs' events", () => {
    const { run, drawn } = drawnAgainst(["baseline", "higher"], "higher");
    expect(run?.name).toBe("Higher altitude");
    expect(drawn.map((e) => [e.label, e.t])).toEqual([
      ["Burnout", 2.6],
      ["Apogee", 24.5],
    ]);
  });

  it("falls back to the first plotted run when the selected run's series is not plotted", () => {
    expect(drawnAgainst(["baseline", "higher"], "fin").run?.id).toBe("baseline");
    expect(drawnAgainst(["higher"], "baseline").run?.id).toBe("higher");
    expect(drawnAgainst(["baseline", "higher"], null).run?.id).toBe("baseline");
    // No plotted series: no event lines.
    expect(drawnAgainst([], "baseline")).toEqual({ run: null, drawn: [] });
  });
});

describe("plot helpers", () => {
  it("floors the y range at 0 for a flight that lands a hair below the pad, not for real negatives", () => {
    expect(yFloor(-0.4, 127)).toBe(0);
    expect(yFloor(3, 127)).toBe(3);
    expect(yFloor(-40, 120)).toBe(-40);
  });

  it("has the four tabs in order", () => {
    expect(PLOT_TABS.map((t) => t.label)).toEqual(["Altitude", "Velocity", "Acceleration", "Stability"]);
    expect(isPlotTab("velocity")).toBe(true);
    expect(isPlotTab("thrust")).toBe(false);
  });

  it("formats legend figures from the summary", () => {
    expect(legendFigure("altitude", SUMMARY)).toBe("612 m");
    expect(legendFigure("velocity", SUMMARY)).toBe("max 119 m/s");
    expect(legendFigure("stability", SUMMARY)).toBe("min 1.62 cal");
    expect(legendFigure("altitude", null)).toBeNull();
    expect(fmtNum(1234.4)).toBe("1,234");
    expect(fmtNum(null)).toBe("—");
  });

  it("aligns two runs with different time grids onto one axis", () => {
    const data = alignLines([
      { id: "a", label: "A", color: "#61b5ad", t: [0, 1, 2], y: [0, 10, 20] },
      { id: "b", label: "B", color: "#f1ae6e", t: [0, 1.5], y: [0, 30] },
    ]);
    expect(Array.from(data[0] as number[])).toEqual([0, 1, 1.5, 2]);
    const a = Array.from(data[1] as (number | null | undefined)[]);
    const b = Array.from(data[2] as (number | null | undefined)[]);
    expect([a[0], a[1], a[3]]).toEqual([0, 10, 20]);
    expect(a[2] == null).toBe(true);
    expect([b[0], b[2]]).toEqual([0, 30]);
    expect(b[1] == null && b[3] == null).toBe(true);
  });
});
