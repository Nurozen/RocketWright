/**
 * B3 (D7, D8): `pnpm --filter @rw/server test -- cards`.
 *
 * The `ui://rw/*` MCP Apps cards (`crates/rw-cli/src/mcp/cards/*.html`) in
 * jsdom, driven by a fake MCP Apps host over postMessage: `ui/initialize`
 * (host context with `--color-ring-primary`), then the tool input and tool
 * result, then the card's own `tools/call`s answered from the same capture.
 * Every tool input, result, and answer is captured from a real run by
 * `scripts/capture-card-fixtures.ts` (`test/fixtures/cards/*.json`).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM, type DOMWindow } from "jsdom";
import { afterEach, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const CARDS = join(HERE, "../../../../crates/rw-cli/src/mcp/cards");
const FIXTURES = join(HERE, "fixtures/cards");
const RING = "#d4a72c";

type Json = Record<string, unknown>;
interface ToolResult {
  content: unknown[];
  structuredContent?: Json;
  isError?: boolean;
  _meta?: Json;
}

const fixture = <T>(name: string): T => JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8")) as T;

interface FlightFixture {
  input: Json;
  result: ToolResult;
  calls: { job_status: ToolResult[]; run_series: { input: Json; result: ToolResult } };
  apogee_m: number;
}
interface EngineFixture {
  input: Json;
  result: ToolResult;
  calls: { run_series: { input: Json; result: ToolResult } };
}
interface EditFixture {
  input: Json;
  result: ToolResult;
}
interface SeriesOut {
  values: Record<string, (number | null)[]>;
}

interface Mounted {
  dom: JSDOM;
  doc: Document;
  calls: { name: string; arguments: Json }[];
  links: string[];
  close(): void;
}

/** Mounts a card at `width` px with a fake host answering `tools/call` through `answer`. */
function mount(card: string, opts: { width: number; toolName: string; input: Json; result: ToolResult; answer?: (name: string, args: Json) => ToolResult }): Mounted {
  const html = readFileSync(join(CARDS, `${card}.html`), "utf8");
  const calls: Mounted["calls"] = [];
  const links: string[] = [];
  let win!: DOMWindow;
  const send = (m: Json) => {
    setTimeout(() => win.dispatchEvent(new win.MessageEvent("message", { data: m, source: win as unknown as MessageEventSource })), 0);
  };
  const respond = (id: unknown, result: unknown) => send({ jsonrpc: "2.0", id, result });
  const fail = (id: unknown, message: string) => send({ jsonrpc: "2.0", id, error: { code: -32000, message } });
  const receive = (m: Json) => {
    const params = (m.params ?? {}) as Json;
    switch (m.method) {
      case "ui/initialize":
        respond(m.id, {
          protocolVersion: "2026-01-26",
          hostInfo: { name: "cards-test", version: "0" },
          hostCapabilities: { serverTools: {}, openLinks: {} },
          hostContext: {
            theme: "dark",
            styles: { variables: { "--color-ring-primary": RING, "--color-text-primary": "#eeeeee" } },
            displayMode: "inline",
            availableDisplayModes: ["inline"],
            containerDimensions: { width: opts.width, maxHeight: 4000 },
            platform: "desktop",
            toolInfo: { tool: { name: opts.toolName } },
          },
        });
        return;
      case "ui/notifications/initialized":
        send({ jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: opts.input } });
        send({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: opts.result });
        return;
      case "tools/call": {
        const name = params.name as string;
        const args = (params.arguments ?? {}) as Json;
        calls.push({ name, arguments: args });
        try {
          if (opts.answer === undefined) throw new Error(`no tool ${name}`);
          respond(m.id, opts.answer(name, args));
        } catch (e) {
          fail(m.id, (e as Error).message);
        }
        return;
      }
      case "ui/open-link":
        links.push(params.url as string);
        respond(m.id, {});
        return;
      default:
    }
  };
  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      win = window;
      Object.defineProperty(window, "innerWidth", { value: opts.width, configurable: true });
      // The card posts to window.parent, which is the window itself at the top level.
      window.postMessage = ((m: Json) => receive(m)) as typeof window.postMessage;
    },
  });
  return { dom, doc: dom.window.document, calls, links, close: () => dom.window.close() };
}

async function until(what: string, ok: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** The drawn polyline's highest point, in the series' own units (SI). */
function drawnPeak(doc: Document): number {
  const svg = doc.querySelector("svg[data-plot]")!;
  const [, y0, , y1] = svg.getAttribute("data-plot")!.split(",").map(Number) as [number, number, number, number];
  const [ya, yb] = svg.getAttribute("data-y-domain")!.split(",").map(Number) as [number, number];
  const scale = Number(svg.getAttribute("data-y-scale"));
  const ys = doc
    .querySelector("polyline")!
    .getAttribute("points")!
    .split(" ")
    .map((p) => Number(p.split(",")[1]));
  const top = Math.min(...ys);
  return (ya + ((y1 - top) / (y1 - y0)) * (yb - ya)) / scale;
}

/** The largest step between neighbouring samples around the series peak. */
function sampleStepAtPeak(values: (number | null)[]): number {
  const v = values.map((x) => x ?? -Infinity);
  const k = v.indexOf(Math.max(...v));
  const near = [v[k - 1], v[k + 1]].filter((x): x is number => x !== undefined && Number.isFinite(x));
  return Math.max(...near.map((x) => Math.abs(v[k]! - x)));
}

const text = (doc: Document, id: string) => doc.querySelector(`[data-testid="${id}"]`)?.textContent ?? null;

let open: Mounted[] = [];
afterEach(() => {
  for (const m of open) m.close();
  open = [];
});

function form(doc: Document, f: "wide" | "narrow"): void {
  const root = doc.getElementById("root")!;
  expect(root.getAttribute("data-form")).toBe(f);
  if (f === "wide") {
    // Chart icon, "Saved result" subtitle, three boxed tiles.
    expect(doc.querySelector('[data-testid="rw.run-card.icon"]')).not.toBeNull();
    expect(text(doc, "rw.run-card.subtitle")).toBe("Saved result");
    expect(doc.querySelectorAll('[data-testid="rw.run-card.tiles"] .tile')).toHaveLength(3);
    expect(doc.querySelector('[data-testid="rw.run-card.chip"]')).toBeNull();
    expect(doc.querySelector('[data-testid="rw.run-card.rows"]')).toBeNull();
  } else {
    // Saved chip and three row stats.
    expect(text(doc, "rw.run-card.chip")).toBe("Saved");
    expect(doc.querySelectorAll('[data-testid="rw.run-card.rows"] .value')).toHaveLength(3);
    expect(doc.querySelector('[data-testid="rw.run-card.tiles"]')).toBeNull();
    expect(doc.querySelector('[data-testid="rw.run-card.subtitle"]')).toBeNull();
  }
  // The chart stroke is the host's --color-ring-primary.
  expect(doc.querySelector("polyline")!.getAttribute("stroke")).toBe(RING);
  expect(doc.documentElement.style.getPropertyValue("--color-ring-primary")).toBe(RING);
}

/**
 * The structure hooks Lecturn's bar probe reads inside the card frame
 * (`desktop.main.card-wide`, `embed.timeline.card-narrow`): the layout on
 * #root, one title row, exactly three stats, and the optional icon, subtitle,
 * chip and chart hooks of Lecturn's counter card.
 */
function hooks(doc: Document, f: "wide" | "narrow"): void {
  const root = doc.getElementById("root")!;
  expect(root.getAttribute("data-card-layout")).toBe(f);
  expect(root.getAttribute("data-card-layout")).toBe(root.getAttribute("data-form"));
  expect(doc.querySelectorAll(`[data-card-layout="${f}"]`)).toHaveLength(1);
  expect(doc.querySelectorAll(`[data-card-layout="${f === "wide" ? "narrow" : "wide"}"]`)).toHaveLength(0);
  const title = doc.querySelectorAll("[data-card-title]");
  expect(title).toHaveLength(1);
  expect(title[0]!.classList.contains("head")).toBe(true);
  expect(title[0]!.querySelector('[data-testid="rw.run-card.open"]')).not.toBeNull();
  const stats = [...doc.querySelectorAll("[data-card-stat]")];
  expect(stats).toHaveLength(3);
  for (const s of stats) {
    // Each stat holds exactly one label/value pair and its value hook.
    expect(s.querySelectorAll(".label")).toHaveLength(1);
    expect(s.querySelectorAll(".value")).toHaveLength(1);
    expect(s.matches("[data-value][data-key]") || s.querySelector("[data-value][data-key]") !== null).toBe(true);
  }
  // The chart hook is the svg carrying the drawn polyline.
  const chart = doc.querySelectorAll("[data-card-chart]");
  expect(chart).toHaveLength(1);
  expect(chart[0]!.tagName.toLowerCase()).toBe("svg");
  expect(chart[0]!.querySelectorAll("polyline")).toHaveLength(1);
  expect(chart[0]!.querySelector("polyline")!.getAttribute("points")!.split(" ").length).toBeGreaterThanOrEqual(2);
  if (f === "wide") {
    expect(stats.every((s) => s.classList.contains("tile"))).toBe(true);
    expect(title[0]!.querySelector("[data-card-icon]")).not.toBeNull();
    expect(doc.querySelector("[data-card-subtitle]")!.textContent).toBe("Saved result");
    expect(doc.querySelector("[data-card-chip]")).toBeNull();
  } else {
    // The narrow wrappers sit in the rows grid and do not take part in its layout.
    expect(stats.every((s) => s.parentElement!.getAttribute("data-testid") === "rw.run-card.rows")).toBe(true);
    expect(stats.every((s) => doc.defaultView!.getComputedStyle(s).display === "contents")).toBe(true);
    expect(title[0]!.querySelector("[data-card-chip]")!.textContent).toBe("Saved");
    expect(doc.querySelector("[data-card-icon]")).toBeNull();
    expect(doc.querySelector("[data-card-subtitle]")).toBeNull();
  }
}

function stat(doc: Document, key: string): number {
  const v = doc.querySelector(`[data-value][data-key="${key}"]`);
  expect(v, key).not.toBeNull();
  return Number(v!.getAttribute("data-value"));
}

describe("ui://rw/run-card (B3)", () => {
  const flight = fixture<FlightFixture>("flight");
  const engine = fixture<EngineFixture>("engine");

  /** A flight run card: `job_status` of the started job (the card a turn shows, POL), else the started `simulate`. */
  function flightHost(width: number, toolName: string): Mounted {
    let polls = 0;
    const job = toolName.endsWith("job_status");
    const m = mount("run-card", {
      width,
      toolName,
      input: job ? { job_id: flight.result.structuredContent!.job_id } : flight.input,
      result: job ? flight.calls.job_status[0]! : flight.result,
      answer: (name, args) => {
        const base = name.replace(/^rw_/, "");
        if (base === "job_status") {
          expect(args.job_id).toBe(flight.result.structuredContent!.job_id);
          return flight.calls.job_status[Math.min(polls++, flight.calls.job_status.length - 1)]!;
        }
        if (base === "run_series") return flight.calls.run_series.result;
        throw new Error(`unexpected ${name}`);
      },
    });
    open.push(m);
    return m;
  }

  for (const [width, f] of [
    [760, "wide"],
    [380, "narrow"],
  ] as const) {
    it(`flight at ${width} px: polls job_status, then draws run_series altitude (${f} form)`, async () => {
      const m = flightHost(width, "job_status");
      await until("the chart", () => m.doc.querySelector("polyline") !== null);
      const names = m.calls.map((c) => c.name);
      expect(names[0]).toBe("job_status");
      expect(names.at(-1)).toBe("run_series");
      expect(m.calls.at(-1)!.arguments).toMatchObject({ sim: "default", run_id: flight.result.structuredContent!.run_id, fields: ["t", "altitude"] });
      form(m.doc, f);
      hooks(m.doc, f);
      // The drawn peak is the run's apogee, within one sample.
      const alt = (flight.calls.run_series.result.structuredContent as unknown as SeriesOut).values.altitude!;
      expect(Math.abs(drawnPeak(m.doc) - flight.apogee_m)).toBeLessThanOrEqual(sampleStepAtPeak(alt) + 0.05);
      expect(stat(m.doc, "apogee_m")).toBe(flight.apogee_m);
      // Open is an app ref Lecturn maps to lecturn/navigate (D8).
      (m.doc.querySelector('[data-testid="rw.run-card.open"]') as HTMLElement).click();
      await until("the open link", () => m.links.length > 0);
      expect(m.links).toEqual([`rw:run/${String(flight.result.structuredContent!.run_id)}`]);
    });
  }

  it("calls tools with the host's prefix (rw_job_status → rw_job_status, rw_run_series)", async () => {
    const m = flightHost(760, "rw_job_status");
    await until("the chart", () => m.doc.querySelector("polyline") !== null);
    expect(new Set(m.calls.map((c) => c.name))).toEqual(new Set(["rw_job_status", "rw_run_series"]));
  });

  for (const [width, f] of [
    [760, "wide"],
    [380, "narrow"],
  ] as const) {
    it(`engine at ${width} px: no job_status, a thrust chart, peak thrust from the samples (${f} form)`, async () => {
      expect(engine.result.structuredContent!.job_id ?? null).toBeNull();
      const m = mount("run-card", {
        width,
        toolName: "engine_simulate",
        input: engine.input,
        result: engine.result,
        answer: (name) => {
          if (name === "run_series") return engine.calls.run_series.result;
          throw new Error(`unexpected ${name}`);
        },
      });
      open.push(m);
      await until("the chart", () => m.doc.querySelector("polyline") !== null);
      expect(m.calls.map((c) => c.name)).toEqual(["run_series"]);
      expect(m.calls[0]!.arguments).toMatchObject({ sim: "engine.demo", fields: ["t_s", "thrust_n", "chamber_pressure_pa"] });
      expect(m.doc.getElementById("root")!.getAttribute("data-kind")).toBe("engine");
      expect(m.doc.querySelector("svg[data-plot]")!.getAttribute("aria-label")).toBe("Thrust over time");
      form(m.doc, f);
      hooks(m.doc, f);
      const values = (engine.calls.run_series.result.structuredContent as unknown as SeriesOut).values;
      const thrust = values.thrust_n!.filter((x): x is number => x !== null);
      expect(stat(m.doc, "peak_thrust_n")).toBe(Math.max(...thrust));
      expect(Math.abs(drawnPeak(m.doc) - Math.max(...thrust))).toBeLessThanOrEqual(sampleStepAtPeak(values.thrust_n!) + 1);
      const pc = values.chamber_pressure_pa!.filter((x): x is number => x !== null);
      expect(stat(m.doc, "peak_chamber_pressure_pa")).toBe(Math.max(...pc));
      expect(stat(m.doc, "burn_time_s")).toBeGreaterThan(0);
    });
  }

  it("draws the narrow chart 90 px tall (CPW1R3A, CP-W1 r4: a run card and its turn fit the embedded pane)", async () => {
    const m = flightHost(380, "job_status");
    await until("the chart", () => m.doc.querySelector("polyline") !== null);
    expect(m.doc.querySelector("svg[data-plot]")!.getAttribute("height")).toBe("90");
  });

  it("the chart's altitude starts at 0, its time axis ends at the last sample, and the narrow form has at most 3 ticks per axis (POL)", async () => {
    const t = (flight.calls.run_series.result.structuredContent as unknown as SeriesOut).values.t!.filter((x): x is number => x !== null);
    for (const [width, most] of [
      [380, 3],
      [760, 6],
    ] as const) {
      const m = flightHost(width, "job_status");
      await until("the chart", () => m.doc.querySelector("polyline") !== null);
      const svg = m.doc.querySelector("svg[data-plot]")!;
      const [ya, yb] = svg.getAttribute("data-y-domain")!.split(",").map(Number) as [number, number];
      const [xa, xb] = svg.getAttribute("data-x-domain")!.split(",").map(Number) as [number, number];
      expect(ya).toBe(0);
      // The top sits just over the apogee (not the next round tick).
      expect(yb).toBeGreaterThan(flight.apogee_m);
      expect(yb).toBeLessThan(flight.apogee_m * 1.1);
      expect([xa, xb]).toEqual([t[0], t.at(-1)]);
      const labels = [...svg.querySelectorAll("text")].map((e) => e.textContent ?? "");
      const yLabels = [...svg.querySelectorAll('text[text-anchor="end"]')].map((e) => Number(e.textContent));
      const xLabels = labels.filter((l) => /^-?\d/.test(l)).length - yLabels.length;
      expect(yLabels[0]).toBe(0);
      expect(yLabels.every((v) => v >= 0 && v <= yb)).toBe(true);
      expect(yLabels.length).toBeLessThanOrEqual(most);
      expect(xLabels).toBeLessThanOrEqual(most);
      // No point drawn under the ground line.
      const [, , , y1] = svg.getAttribute("data-plot")!.split(",").map(Number) as [number, number, number, number];
      const ys = m.doc.querySelector("polyline")!.getAttribute("points")!.split(" ").map((p) => Number(p.split(",")[1]));
      expect(Math.max(...ys)).toBeLessThanOrEqual(y1);
    }
  });

  it("a simulate that only started a job is one line that follows it; the job_status card draws the run (POL)", async () => {
    const m = flightHost(352, "rw_simulate");
    const root = m.doc.getElementById("root")!;
    await until("the started line", () => root.getAttribute("data-kind") === "started");
    await until("the run's end", () => root.getAttribute("data-phase") === "complete");
    expect(text(m.doc, "rw.run-card.state")).toBe(`Apogee ${flight.apogee_m.toFixed(0)} m`);
    expect(text(m.doc, "rw.run-card.chip")).toBe("Saved");
    expect(text(m.doc, "rw.run-card.open")).toBe("Default run ›");
    // No chart, no stats, no samples read: the job_status card has them.
    expect(root.querySelector("svg[data-plot]")).toBeNull();
    expect(root.querySelectorAll("[data-card-stat]")).toHaveLength(0);
    expect(new Set(m.calls.map((c) => c.name))).toEqual(new Set(["rw_job_status"]));
    (m.doc.querySelector('[data-testid="rw.run-card.open"]') as HTMLElement).click();
    await until("the open link", () => m.links.length > 0);
    expect(m.links).toEqual([`rw:run/${String(flight.result.structuredContent!.run_id)}`]);
  });

  it("run_diff draws both runs in the Results series colours (teal, then sand) and opens the second (POL, page 04)", async () => {
    const series = flight.calls.run_series.result.structuredContent as unknown as SeriesOut & Json;
    const half = { ...series, values: { ...series.values, altitude: series.values.altitude!.map((y) => (y === null ? null : y / 3)) } };
    const [ra, rb] = ["aaaaaaaaaaaa", "bbbbbbbbbbbb"];
    const runs = [
      { sim: "baseline", sim_name: "Baseline", run_id: ra, kind: "flight", status: "complete", summary: { apogee_m: 38.2, max_velocity_ms: 22.04, time_to_apogee_s: 3.4 } },
      { sim: "higher_altitude", sim_name: "Higher altitude", run_id: rb, kind: "flight", status: "complete", summary: { apogee_m: 114.56, max_velocity_ms: 45.6, time_to_apogee_s: 5.0 } },
    ];
    const m = mount("run-card", {
      width: 352,
      toolName: "rw_run_diff",
      input: { a: "baseline", b: "higher_altitude" },
      result: { content: [], structuredContent: { a: `baseline/${ra}`, b: `higher_altitude/${rb}`, mismatches: [], rows: [], pass: true } },
      answer: (name, args) => {
        if (name === "rw_run_list") return { content: [], structuredContent: { model_hash: "h", runs } } as unknown as ToolResult;
        if (name === "rw_run_series") return { content: [], structuredContent: args.run_id === ra ? half : series } as unknown as ToolResult;
        throw new Error(`unexpected ${name}`);
      },
    });
    open.push(m);
    await until("both traces", () => m.doc.querySelectorAll("polyline").length === 2);
    const root = m.doc.getElementById("root")!;
    expect(root.getAttribute("data-kind")).toBe("flight");
    expect(root.getAttribute("data-compare")).toBe("2");
    expect(root.getAttribute("data-phase")).toBe("complete");
    const lines = [...m.doc.querySelectorAll("polyline")];
    expect(lines.map((l) => [l.getAttribute("data-series"), l.getAttribute("stroke")])).toEqual([
      ["a", "#61b5ad"],
      ["b", "#f1ae6e"],
    ]);
    // The page's colours: web state/types.ts SERIES_COLORS.
    const types = readFileSync(join(HERE, "../../web/src/state/types.ts"), "utf8");
    expect(types).toContain('SERIES_COLORS = ["#61b5ad", "#f1ae6e"]');
    expect(m.calls.filter((c) => c.name === "rw_run_series").map((c) => c.arguments.run_id).sort()).toEqual([ra, rb]);
    expect(text(m.doc, "rw.run-card.open")).toBe("Baseline vs Higher altitude ›");
    expect(text(m.doc, "rw.run-card.chip")).toBe("Saved");
    const apogee = m.doc.querySelector('.value[data-key="apogee_m"]')!;
    expect(apogee.textContent).toBe("38.2 → 114.6 m");
    expect([...apogee.querySelectorAll("span")].map((x) => (x as HTMLElement).style.color)).toEqual(["rgb(97, 181, 173)", "rgb(241, 174, 110)"]);
    expect(root.querySelectorAll("[data-card-stat]")).toHaveLength(3);
    (m.doc.querySelector('[data-testid="rw.run-card.open"]') as HTMLElement).click();
    await until("the open link", () => m.links.length > 0);
    expect(m.links).toEqual([`rw:run/${rb}`]);
  });

  it("run_diff of bare sims (an imported thread's row) resolves them through the run list", async () => {
    const runs = [
      { sim: "baseline", run_id: "aaaaaaaaaaaa", kind: "flight", status: "complete", summary: { apogee_m: 38.2 } },
      { sim: "higher_altitude", run_id: "cccccccccccc", kind: "flight", status: "outdated", superseded_by: "bbbbbbbbbbbb" },
      { sim: "higher_altitude", run_id: "bbbbbbbbbbbb", kind: "flight", status: "complete", summary: { apogee_m: 114.55 } },
    ];
    const m = mount("run-card", {
      width: 352,
      toolName: "rw_run_diff",
      input: { a: "baseline", b: "higher_altitude" },
      result: { content: [], structuredContent: {} },
      answer: (name) => {
        if (name === "rw_run_list") return { content: [], structuredContent: { model_hash: "h", runs } } as unknown as ToolResult;
        if (name === "rw_run_series") return flight.calls.run_series.result;
        throw new Error(`unexpected ${name}`);
      },
    });
    open.push(m);
    await until("both traces", () => m.doc.querySelectorAll("polyline").length === 2);
    expect(m.calls.filter((c) => c.name === "rw_run_series").map((c) => c.arguments.run_id).sort()).toEqual(["aaaaaaaaaaaa", "bbbbbbbbbbbb"]);
    expect(text(m.doc, "rw.run-card.open")).toBe("Baseline vs Higher Altitude ›");
  });

  it("a visual flow study is a view card: Section view, no samples, Open goes to rw:sim/<study> (CPW1R3A)", async () => {
    const visual = fixture<{ input: Json; result: ToolResult; calls: { run_list: { input: Json; result: ToolResult } } }>("visual");
    const m = mount("run-card", {
      width: 352,
      toolName: "rw_simulate",
      input: visual.input,
      result: visual.result,
      answer: (name, args) => {
        if (name === "rw_run_list") {
          expect(args).toEqual(visual.calls.run_list.input);
          return visual.calls.run_list.result;
        }
        throw new Error(`unexpected ${name}`);
      },
    });
    open.push(m);
    await until("the view card", () => m.doc.getElementById("root")!.getAttribute("data-kind") === "visual");
    const root = m.doc.getElementById("root")!;
    expect(root.getAttribute("data-phase")).toBe("complete");
    expect(text(m.doc, "rw.run-card.title")).toBe("Section view · Study 01");
    expect(text(m.doc, "rw.run-card.subtitle")).toBe("Cutaway of tank and engine · visual model");
    expect(root.querySelector("svg[data-plot]")).toBeNull();
    expect(root.querySelectorAll("[data-card-stat]")).toHaveLength(0);
    expect(m.calls.map((c) => c.name)).toEqual(["rw_run_list"]);
    (m.doc.querySelector('[data-testid="rw.run-card.open"]') as HTMLElement).click();
    await until("the open link", () => m.links.length > 0);
    expect(m.links).toEqual(["rw:sim/study_01"]);
  });

  it("a complete job_status without a summary takes it from the run list, then draws the run (CPW1R4A: imported threads)", async () => {
    const done = flight.calls.job_status.at(-1)!;
    const { summary, ...job } = done.structuredContent as Record<string, unknown>;
    expect(job["state"]).toBe("complete");
    const runList = { content: [], structuredContent: { model_hash: "x", runs: [{ sim: "default", run_id: job["run_id"], kind: "flight", status: "complete", summary }] } } as unknown as ToolResult;
    const m = mount("run-card", {
      width: 352,
      toolName: "rw_job_status",
      input: { job_id: job["job_id"] },
      result: { content: [], structuredContent: job } as unknown as ToolResult,
      answer: (name) => {
        if (name === "rw_run_list") return runList;
        if (name === "rw_run_series") return flight.calls.run_series.result;
        throw new Error(`unexpected ${name}`);
      },
    });
    open.push(m);
    await until("the chart", () => m.doc.querySelector("polyline") !== null);
    expect(m.calls.map((c) => c.name)).toEqual(["rw_run_list", "rw_run_series"]);
    expect(stat(m.doc, "apogee_m")).toBe(flight.apogee_m);
    expect(text(m.doc, "rw.run-card.chip")).toBe("Saved");
  });

  it("a gated engine call shows its approval reason and calls nothing", async () => {
    const gated = fixture<{ input: Json; gated: ToolResult }>("engine");
    const m = mount("run-card", { width: 380, toolName: "engine_simulate", input: gated.input, result: gated.gated });
    open.push(m);
    await until("the approval state", () => m.doc.getElementById("root")!.getAttribute("data-phase") === "approval");
    expect(text(m.doc, "rw.run-card.chip")).toBe("Needs approval");
    expect(m.doc.querySelector(".note")!.textContent).toBe("Burn duration not set · default 120 s");
    expect(m.calls).toEqual([]);
  });
});

describe("ui://rw/step-card (B3)", () => {
  it("shows the edit, its step and changed fields, and Compare opens rw:step/<n>", async () => {
    const step = fixture<EditFixture>("step");
    const m = mount("step-card", { width: 380, toolName: "model_patch", input: step.input, result: step.result });
    open.push(m);
    await until("the result", () => text(m.doc, "rw.step-card.subtitle") === "Step 2");
    expect(text(m.doc, "rw.step-card.title")).toBe("Set fins.span to 50 mm");
    // Title-row hooks for Lecturn's bar probe.
    const head = m.doc.querySelectorAll("[data-card-title]");
    expect(head).toHaveLength(1);
    expect(head[0]!.querySelector('[data-testid="rw.step-card.title"]')).not.toBeNull();
    expect(head[0]!.querySelector("[data-card-icon]")).not.toBeNull();
    expect(head[0]!.querySelector("[data-card-subtitle]")!.textContent).toBe("Step 2");
    const changed = Object.keys((step.result.structuredContent!.delta as { changed: Json }).changed);
    const rows = [...m.doc.querySelectorAll('[data-testid="rw.step-card.changes"] li')].map((li) => li.getAttribute("data-key"));
    expect(rows).toEqual(changed.slice(0, 6));
    (m.doc.querySelector('[data-testid="rw.step-card.compare"]') as HTMLElement).click();
    await until("the open link", () => m.links.length > 0);
    expect(m.links).toEqual(["rw:step/2"]);
  });
});

describe("ui://rw/step-card, compact (CPW1R3A)", () => {
  it("history_show names the seeded step in one row: its title, Step <n> with the diff count, Compare", async () => {
    const shown = fixture<EditFixture>("history-show");
    const m = mount("step-card", { width: 352, toolName: "rw_history_show", input: shown.input, result: shown.result });
    open.push(m);
    await until("the result", () => text(m.doc, "rw.step-card.title") === "Flight runs");
    const root = m.doc.getElementById("root")!;
    expect(root.getAttribute("data-tool")).toBe("history_show");
    expect(root.getAttribute("data-form")).toBe("compact");
    expect(text(m.doc, "rw.step-card.subtitle")).toBe("Step 4 · 3 changed");
    // One row: the head holds Compare; nothing under it; the subtitle under the title, the card as tall
    // as Lecturn's 80 px minimum card frame (CPW1R4A, CP-W1 r4).
    expect(root.children).toHaveLength(1);
    expect(root.querySelector('[data-card-title] [data-testid="rw.step-card.compare"]')).not.toBeNull();
    expect(m.doc.defaultView!.getComputedStyle(root.querySelector(".titles")!).flexDirection).toBe("column");
    expect(m.doc.defaultView!.getComputedStyle(root).minHeight).toBe("80px");
    (m.doc.querySelector('[data-testid="rw.step-card.compare"]') as HTMLElement).click();
    await until("the open link", () => m.links.length > 0);
    expect(m.links).toEqual(["rw:step/4"]);
  });

  it("history_show of a step with no component change says only Step <n> (CPW1R4A: the bundles' step cards)", async () => {
    const result: ToolResult = { content: [], structuredContent: { step: { seq: 4, title: "Flight runs" }, diff: { a: "step:3", b: "step:4", added: [], removed: [], changed: [] } } };
    const m = mount("step-card", { width: 352, toolName: "rw_history_show", input: { version: "step:4" }, result });
    open.push(m);
    await until("the result", () => text(m.doc, "rw.step-card.title") === "Flight runs");
    expect(text(m.doc, "rw.step-card.subtitle")).toBe("Step 4");
    expect(m.doc.getElementById("root")!.getAttribute("data-form")).toBe("compact");
  });

  it("an edit that changed no metric is one row, its check status in the subtitle", async () => {
    const result: ToolResult = { content: [], structuredContent: { step: "4", dry_run: false, delta: { step: "4", status: "clean", changed: {} } } };
    const m = mount("step-card", { width: 352, toolName: "rw_model_patch", input: { label: "Flight runs", ops: [] }, result });
    open.push(m);
    await until("the result", () => text(m.doc, "rw.step-card.subtitle") === "Step 4 · Check clean");
    const root = m.doc.getElementById("root")!;
    expect(root.getAttribute("data-form")).toBe("compact");
    expect(root.querySelector(".empty")).toBeNull();
    expect(root.querySelector("[data-card-chip]")).toBeNull();
    expect(root.children).toHaveLength(1);
    expect(text(m.doc, "rw.step-card.title")).toBe("Flight runs");
  });

  it("an edit with changed metrics keeps the full form (chip, rows, Compare below)", async () => {
    const step = fixture<EditFixture>("step");
    const m = mount("step-card", { width: 352, toolName: "model_patch", input: step.input, result: step.result });
    open.push(m);
    await until("the result", () => text(m.doc, "rw.step-card.subtitle") === "Step 2");
    const root = m.doc.getElementById("root")!;
    expect(root.getAttribute("data-form")).toBe("full");
    expect(root.querySelector("[data-card-chip]")!.textContent).toBe("Check clean");
    expect(root.querySelector(".actions [data-testid=\"rw.step-card.compare\"]")).not.toBeNull();
  });
});

describe("ui://rw/render-card (B3)", () => {
  it("takes its thumbnail from the result's image block", async () => {
    const render = fixture<EditFixture>("render");
    const m = mount("render-card", { width: 380, toolName: "render", input: render.input, result: render.result });
    open.push(m);
    await until("the thumbnail", () => m.doc.querySelector('[data-testid="rw.render-card.thumb"]') !== null);
    const img = render.result.content.find((b) => (b as Json).type === "image") as { data: string };
    expect(m.doc.querySelector("img")!.getAttribute("src")).toBe(`data:image/png;base64,${img.data}`);
    expect(m.doc.querySelector(".title")!.textContent).toBe("Profile view");
    expect(m.doc.getElementById("root")!.getAttribute("data-card-layout")).toBe("narrow");
    expect(m.doc.querySelectorAll("[data-card-title]")).toHaveLength(1);
    expect(m.doc.querySelector("[data-card-title]")!.textContent).toBe("Profile view");
    expect(m.calls).toEqual([]);
  });

  it("reads the picture through render_picture when the host omits the image data (Lecturn pin4)", async () => {
    const render = fixture<EditFixture>("render");
    const img = render.result.content.find((b) => (b as Json).type === "image") as { data: string };
    const stripped = { ...render.result, content: render.result.content.map((b) => ((b as Json).type === "image" ? { type: "image", mimeType: "image/png" } : b)) };
    const path = (render.result.structuredContent as Json).path as string;
    const m = mount("render-card", {
      width: 380,
      toolName: "rw_render",
      input: render.input,
      result: stripped,
      answer: (name, args) => {
        if (name !== "rw_render_picture" || args.path !== path) throw new Error(`unexpected ${name}`);
        return { content: [{ type: "text", text: "{}" }, { type: "image", mimeType: "image/png", data: img.data }], structuredContent: { path, bytes: 1 } };
      },
    });
    open.push(m);
    await until("the thumbnail", () => m.doc.querySelector('[data-testid="rw.render-card.thumb"]') !== null);
    expect(m.doc.querySelector("img")!.getAttribute("src")).toBe(`data:image/png;base64,${img.data}`);
    expect(m.calls).toEqual([{ name: "rw_render_picture", arguments: { path } }]);
  });

  // CPW2B: window renders (rw_plot_render, rw_viewport_render) carry the path the app server stored their PNG at.
  for (const [toolName, input, sc, title] of [
    ["rw_plot_render", { plot: "altitude", runs: ["baseline"] }, { width: 1000, height: 600, plot: "altitude", runs: [], path: "renders/window/plot_render.0123456789abcdef.png" }, "Altitude plot"],
    ["rw_viewport_render", { view: "iso" }, { width: 800, height: 600, backend: "webgpu", adapter: "x", path: "renders/window/viewport_render.0123456789abcdef.png" }, "Iso view"],
  ] as const) {
    it(`${toolName}: reads the stored window render through rw_render_picture when the host omits the image data`, async () => {
      const img = (fixture<EditFixture>("render").result.content.find((b) => (b as Json).type === "image") as { data: string }).data;
      const m = mount("render-card", {
        width: 380,
        toolName,
        input,
        result: { content: [{ type: "image", mimeType: "image/png" }, { type: "text", text: "{}" }], structuredContent: { ...sc } },
        answer: (name, args) => {
          if (name !== "rw_render_picture" || args.path !== sc.path) throw new Error(`unexpected ${name} ${JSON.stringify(args)}`);
          return { content: [{ type: "text", text: "{}" }, { type: "image", mimeType: "image/png", data: img }], structuredContent: { path: sc.path, bytes: 1 } };
        },
      });
      open.push(m);
      await until("the thumbnail", () => m.doc.querySelector('[data-testid="rw.render-card.thumb"]') !== null);
      expect(m.doc.querySelector("img")!.getAttribute("src")).toBe(`data:image/png;base64,${img}`);
      expect(m.calls).toEqual([{ name: "rw_render_picture", arguments: { path: sc.path } }]);
      expect(m.doc.querySelector("[data-card-title]")!.textContent).toBe(title);
      expect(m.doc.getElementById("root")!.textContent).not.toContain("No picture");
    });
  }

  it("a window render without a stored path still says No picture (and calls nothing)", async () => {
    const m = mount("render-card", {
      width: 380,
      toolName: "rw_plot_render",
      input: { plot: "altitude", runs: [] },
      result: { content: [{ type: "image", mimeType: "image/png" }], structuredContent: { width: 10, height: 10, plot: "altitude" } },
    });
    open.push(m);
    await until("the empty thumbnail", () => (m.doc.getElementById("root")!.textContent ?? "").includes("No picture"));
    expect(m.calls).toEqual([]);
  });
});
