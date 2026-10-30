/** M1.53 capture plumbing: thread fixtures, page scripts, desktop arguments, and report lines (no Electron). */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadThreads } from "../capture/hooks.ts";
import { REPO_ROOT } from "../bar/paths.ts";
import { captureScript, desktopArgs, driveClip, driveLines, packetScope, parseArgs, parseTarget, probeFailure, SEED_FIXTURE, targetName } from "../bar/visual.ts";
import { loadExpected } from "../../../scripts/fixtures/seed.ts";

/** Component ids declared in the research-vehicle fixture (`[c.<id>]` tables). */
function fixtureComponents(): Set<string> {
  const files = [join(SEED_FIXTURE, "rocket.rw.toml"), ...readdirSync(join(SEED_FIXTURE, "parts")).map((f) => join(SEED_FIXTURE, "parts", f))];
  const ids = new Set<string>();
  for (const f of files) for (const m of readFileSync(f, "utf8").matchAll(/^\[c\.([a-z0-9_]+)\]/gm)) ids.add(m[1]!);
  return ids;
}

describe("thread fixtures", () => {
  const LAST: Record<string, string> = { "01": "Assembly review", "02": "Fin revision", "03": "Motor comparison", "04": "Flight comparison", "06": "Tank motion" };
  it.each(["01", "02", "03", "04", "06"])("page %s: valid, ends on the concept thread, refs exist in the fixture", (page) => {
    const f = loadThreads(page);
    expect(f.threads.at(-1)!.thread).toBe(LAST[page]);
    const comps = fixtureComponents();
    const names = (dir: string) => new Set(readdirSync(join(SEED_FIXTURE, dir)).map((f) => f.replace(/\.rw\.toml$/, "")));
    const sims = names("sims");
    const configs = names("configs");
    const refs = JSON.stringify(f).match(/rw:(c|sim|cfg)\/[a-z0-9_]+/g) ?? [];
    expect(refs.length).toBeGreaterThan(0);
    for (const r of refs) {
      const [kind, id] = r.slice(3).split("/") as [string, string];
      expect(kind === "c" ? comps.has(id) : kind === "cfg" ? configs.has(id) : sims.has(id), r).toBe(true);
    }
  });

  it("seeds the concept threads, and every step card binds to a real seeded step (M1.53b)", () => {
    // Both pages list the concept's three threads, bound to that page, with the concept's ages (3m, 1h, 2h once floored).
    for (const [p, page] of [["01", "assembly"], ["02", "components"], ["03", "configurations"], ["04", "results"]] as const) {
      // Page 03 adds its own Motor comparison thread (concept 03 agent pane).
      const threads = loadThreads(p).threads.filter((t) => p !== "03" || t.thread !== "Motor comparison");
      expect(threads.map((t) => t.thread).sort(), p).toEqual(["Assembly review", "Fin revision", "Flight comparison"]);
      for (const t of threads) expect(t.binding, `${p} ${t.thread}`).toEqual({ page });
      // The rail's age (relativeAge: whole minutes, then hours), also 30 s early (the shell's age clock ticks every 30 s).
      const shown = (ms: number) => (ms < 3_600_000 ? `${Math.floor(ms / 60_000)}m` : `${Math.floor(ms / 3_600_000)}h`);
      const want = { "Assembly review": "3m", "Fin revision": "1h", "Flight comparison": "2h" } as Record<string, string>;
      for (const t of threads) {
        expect(shown(t.ageMs ?? 0), `${p} ${t.thread}`).toBe(want[t.thread]);
        expect(shown((t.ageMs ?? 0) - 30_000), `${p} ${t.thread} (clock lag)`).toBe(want[t.thread]);
      }
    }
    // The page-04 exchange compares two runs, so its reply is the run comparison card.
    const flight = loadThreads("04").threads.at(-1)!;
    expect(flight.messages[0]!.mentions?.map((m) => m.ref)).toEqual(["rw:sim/baseline", "rw:sim/higher_altitude"]);
    const steps = new Map(loadExpected().steps.map((s) => [`rw:step/${s.seq}`, s.title]));
    // A message's result cards, and (CPW1R4A) the cards of its steps' calls.
    type Card = { kind: string; ref: string; title: string };
    const callCards = (m: { steps?: object[] }): Card[] => (m.steps ?? []).flatMap((s) => ("card" in s ? [s.card as Card] : []));
    const cards: Card[] = ["01", "02", "03", "04", "05"].flatMap((p) => loadThreads(p).threads.flatMap((t) => t.messages.flatMap((m) => [...(m.cards ?? []), ...callCards(m)])));
    const stepCards = cards.filter((c) => c.kind === "step");
    expect(stepCards.length).toBeGreaterThanOrEqual(2);
    for (const c of stepCards) expect(steps.get(c.ref), c.ref).toBe(c.title);
    // Page 02's fin edits name the real seeded fin revision (their MutationOut steps).
    const finSteps = loadThreads("02").threads.at(-1)!.messages.flatMap((m) => m.steps ?? []).filter((s) => s.tool === "model_patch").map((s) => (s.output as { step?: string } | undefined)?.step);
    expect(finSteps.length).toBeGreaterThan(0);
    for (const s of finSteps) expect(steps.get(`rw:step/${String(s).replace("step:", "")}`), String(s)).toBe("Fin revision");
  });

  it("page 06: Tank motion is the concept exchange, its section view card names a visual flow study (M5.5)", () => {
    const t = loadThreads("06").threads.at(-1)!;
    expect(t.binding).toEqual({ page: "propulsion-sim" });
    expect(t.messages[0]!.text).toBe("Show how the fluid moves as the vehicle tilts.");
    expect(t.messages[0]!.mentions?.map((m) => m.label)).toEqual(["Tank section"]);
    expect(t.messages[1]!.steps).toHaveLength(1);
    const card = t.messages[1]!.cards?.[0];
    expect(card).toMatchObject({ kind: "render", title: "Section view · Cutaway of tank and engine" });
    const sim = readFileSync(join(SEED_FIXTURE, "sims", `${card!.ref.replace("rw:sim/", "")}.rw.toml`), "utf8");
    expect(sim).toMatch(/^kind = "visual_flow"$/m);
  });

  it("rejects a malformed fixture", () => {
    const dir = mkdtempSync(join(tmpdir(), "rw-threads-"));
    try {
      writeFileSync(join(dir, "09.json"), JSON.stringify({ description: "", threads: [{ thread: "x", messages: [{ role: "bot", text: "" }] }] }));
      expect(() => loadThreads("09", dir)).toThrow(/bad message/);
      writeFileSync(join(dir, "09.json"), JSON.stringify({ description: "", threads: [] }));
      expect(() => loadThreads("09", dir)).toThrow(/no threads/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("bar-visual wiring", () => {
  it("pages 01-06 have capture scripts (06 Visual flow; 06-engineering its Engineering tier)", () => {
    for (const p of ["01", "02", "03", "04", "05", "06"] as const) expect(captureScript(p)).toBe(join(REPO_ROOT, `app/e2e/capture/pages/${p}.ts`));
    expect(captureScript("06", undefined, "engineering")).toBe(join(REPO_ROOT, "app/e2e/capture/pages/06-engineering.ts"));
    expect(captureScript("06", undefined, "nope")).toBeNull();
  });

  it("takes a capture script's motion clip only from inside the page's output directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "rw-clip-"));
    try {
      writeFileSync(join(dir, "motion.png"), "x");
      expect(driveClip({ clip: "motion.png" }, dir)).toBe(join(dir, "motion.png"));
      expect(driveClip({ clip: "missing.png" }, dir)).toBeNull();
      expect(driveClip({ clip: "../motion.png" }, dir)).toBeNull();
      expect(driveClip({}, dir)).toBeNull();
      expect(driveClip(null, dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("parses page variants (06-engineering: page 06's Engineering tier)", () => {
    expect(parseTarget("05")).toEqual({ page: "05", variant: null });
    expect(parseTarget("06-engineering")).toEqual({ page: "06", variant: "engineering" });
    expect(parseTarget("07")).toBeNull();
    expect(parseTarget("06-")).toBeNull();
    expect(targetName({ page: "06", variant: "engineering" })).toBe("06-engineering");
  });

  it("drives the live project only when a script exists", () => {
    const live = desktopArgs("01", "/o", { project: "/p/Research vehicle", drive: "/d/01.ts" });
    expect(live.slice(live.indexOf("--project"), live.indexOf("--project") + 4)).toEqual(["--project", "/p/Research vehicle", "--drive", "/d/01.ts"]);
    expect(live).toContain("--measure");
    const shell = desktopArgs("05", "/o", null);
    expect(shell).not.toContain("--project");
    expect(shell).not.toContain("--drive");
  });

  it("reports the reached state and any pending runs", () => {
    expect(driveLines(undefined)).toEqual(["  state static shell (no capture script)"]);
    expect(driveLines({ state: { view: "iso" } })).toEqual(['  state {"view":"iso"}']);
    const lines = driveLines({ overlaid: [], pending: ["baseline"], runs: [{ sim: "baseline", started: false, note: "not implemented" }] });
    expect(lines[1]).toBe("  pending runs baseline: baseline: not implemented");
  });
});

describe("bar-visual failure line (CPW2B)", () => {
  it("names the agent pane's lecturnError, the page error and the measure error, then the console", () => {
    const pane = "the agent pane's guest is not laid out at its bounds: the guest is 381x522 (document 522 px tall), its bounds 381x568";
    const line = probeFailure("02", { page: { status: "ready" }, lecturnError: pane, console: ["[warn] x"] });
    expect(line.split("\n")).toEqual(["page 02: shell ready", `agent pane: ${pane}`, "[warn] x"]);
    expect(probeFailure("03", { page: { status: "error", error: "timed out" }, measureError: "boom" }).split("\n")).toEqual(["page 03: shell error", "timed out", "boom"]);
    expect(probeFailure("01", { page: { status: "ready" } })).toBe("page 01: shell ready (no measurements)");
  });
});

describe("critic packet scope (FIDELITY / BC)", () => {
  it("defaults to M1 without fidelity", () => {
    expect(packetScope("01")).toEqual({ milestone: "M1", fidelity: false });
  });

  it("FIDELITY=1 scopes to the page's fidelity milestone", () => {
    expect(packetScope("01", { fidelity: true })).toEqual({ milestone: "M3", fidelity: true });
    expect(packetScope("05", { fidelity: true })).toEqual({ milestone: "M4", fidelity: true });
    expect(packetScope("06", { fidelity: true })).toEqual({ milestone: "M5", fidelity: true });
  });

  it("BC=BC5 is the M3 gate with fidelity on; earlier checkpoints keep it off", () => {
    expect(packetScope("01", { bc: "BC5" })).toEqual({ milestone: "M3", fidelity: true });
    expect(packetScope("02", { bc: "bc5" })).toEqual({ milestone: "M3", fidelity: true });
    expect(packetScope("02", { bc: "BC4" })).toEqual({ milestone: "M2", fidelity: false });
    expect(packetScope("01", { bc: "BC4", fidelity: true })).toEqual({ milestone: "M2", fidelity: true });
    expect(packetScope("01", { fidelity: true, milestone: "M4" })).toEqual({ milestone: "M4", fidelity: true });
    expect(() => packetScope("01", { bc: "BC9" })).toThrow(/unknown checkpoint/);
    expect(() => packetScope("01", { milestone: "M9" })).toThrow(/--milestone/);
  });

  it("parses --fidelity, --bc, and --milestone", () => {
    expect(parseArgs(["--pages", "01,02", "--fidelity", "--bc", "BC5"]).scope).toEqual({ fidelity: true, bc: "BC5", milestone: null });
    expect(parseArgs(["--pages", "01"]).scope).toEqual({ fidelity: false, bc: null, milestone: null });
    expect(() => parseArgs(["--pages", "01", "--bc", "BC42"])).toThrow(/unknown checkpoint/);
  });
});
