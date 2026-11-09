/** The stage order and the row driver, on a fake page that answers by accessible name. */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Expect, Locator, Page } from "@playwright/test";
import { describe, expect, it } from "vitest";
import { buildProgress, writeProgress } from "../case1-progress.ts";
import { boundRows, type BoundRow } from "../case1-script.ts";
import { STAGE_IDS, driveRow, runStages, type DriveContext, type RowStatus } from "../case1-stages.ts";
import { SCRATCH } from "../live.ts";

interface Fake {
  page: Page;
  log: string[];
  missing: Set<string>;
  units: Map<string, string>;
  /** Whole-run tests: every unit-bearing field shows the unit its row asks for. */
  anyUnit: boolean;
}

function fakeLocator(fake: Fake, key: string): Locator {
  const scoped = (next: string) => fakeLocator(fake, next);
  const act = (what: string) => async () => {
    fake.log.push(`${what} ${key}`);
    if (fake.missing.has(key)) throw new Error(`no ${key}`);
  };
  return {
    key,
    getByRole: (role: string, o?: { name?: string | RegExp }) => scoped(`${role}:${String(o?.name ?? "")}`),
    getByLabel: (label: string) => scoped(`label:${label}`),
    getByText: (text: string) => scoped(`text:${text}`),
    first: () => fakeLocator(fake, key),
    nth: () => fakeLocator(fake, key),
    click: act("click"),
    check: act("check"),
    hover: act("hover"),
    fill: async (v: string) => {
      await act(`fill(${v})`)();
    },
    press: act("press"),
    selectOption: async (o: { label: string }) => {
      await act(`select(${o.label})`)();
    },
    allInnerTexts: async () => (key === "columnheader:" ? ["Apogee (m)", "Max speed (m/s)", "Flight time (s)"] : key === "cell:" ? ["348", "105", "91"] : []),
  } as unknown as Locator;
}

function fakePage(): Fake {
  const fake: Fake = { page: null as unknown as Page, log: [], missing: new Set(), units: new Map(), anyUnit: false };
  fake.page = fakeLocator(fake, "page") as unknown as Page;
  return fake;
}

function fakeExpect(fake: Fake): Expect {
  return ((loc: Locator) => {
    const key = (loc as unknown as { key: string }).key;
    return {
      toBeVisible: async () => {
        if (fake.missing.has(key)) throw new Error(`not visible: ${key}`);
      },
      toBeHidden: async () => undefined,
      toBeChecked: async () => undefined,
      toHaveValue: async () => undefined,
      toHaveAccessibleDescription: async (re: RegExp) => {
        if (fake.anyUnit) return;
        const unit = fake.units.get(key) ?? "mm";
        if (!re.test(unit)) throw new Error(`description ${unit}`);
      },
    };
  }) as unknown as Expect;
}

function context(fake: Fake): DriveContext {
  const lifecycle = { chooseFolder: async () => "/tmp/x", quit: async () => undefined, relaunch: async () => fake.page, finish: async () => undefined };
  return { page: fake.page, expect: fakeExpect(fake), lifecycle, projectName: "A simple model rocket", statuses: new Map<string, RowStatus>(), added: new Set(), timeouts: { row: 10, launch: 10, run: 10 }, timing: {}, tableReads: [] };
}

const rows = boundRows();
const row = (key: string): BoundRow => rows.find((r) => r.key === key)!;

describe("the stages", () => {
  it("keeps the plan's stage order", () => {
    expect(STAGE_IDS.slice(STAGE_IDS.indexOf("materials"))).toEqual(["materials", "nose", "body", "others", "block", "fields", "motor", "deploy", "sim", "run", "quit", "reopen", "compare"]);
  });

  it("requires every stage, in order, and every row", async () => {
    const fake = fakePage();
    fake.anyUnit = true;
    const finished: string[] = [];
    const ctx = context(fake);
    ctx.lifecycle.finish = async () => void finished.push("finish");
    await runStages(ctx);
    expect(finished).toEqual(["finish"]);
    expect([...ctx.statuses.values()].every((s) => s === "reached")).toBe(true);
    expect(ctx.statuses.size).toBe(rows.length);
    expect(ctx.timing.runClickedAt).toBeDefined();
    expect(ctx.timing.quitAt).toBeDefined();
    expect(ctx.tableReads).toHaveLength(2);
    const addNose = fake.log.findIndex((l) => l.includes("button:Nose cone"));
    const addBody = fake.log.findIndex((l) => l.includes("button:Body tube"));
    expect(fake.log.findIndex((l) => l.includes("Create project"))).toBeLessThan(addNose);
    expect(addNose).toBeLessThan(addBody);
  });

  it("marks the failing row, names part and label, and stops at the failing stage", async () => {
    const fake = fakePage();
    fake.anyUnit = true;
    fake.missing.add("label:Length");
    const ctx = context(fake);
    const finished: string[] = [];
    ctx.lifecycle.finish = async () => void finished.push("finish");
    await expect(runStages(ctx)).rejects.toThrow(/not-found: part "Nose cone", label "Length"/);
    expect(ctx.statuses.get("c.nose.length")).toBe("not-found");
    expect(ctx.statuses.get("c.nose.od")).toBe("reached");
    expect(ctx.statuses.get("c.body.type")).toBe("pending");
    expect(finished).toEqual([]);
  });
});

describe("driveRow", () => {
  it("reaches a field through its visible tab and label, and types in the shown unit", async () => {
    const fake = fakePage();
    const ctx = context(fake);
    await driveRow(ctx, row("c.nose.length"));
    expect(fake.log).toEqual([
      "click tab:Design",
      "click tab:Components",
      "click treeitem:/Nose cone(?! \\d)/i",
      "click tab:Geometry",
      "fill(100) label:Length",
      "press label:Length",
    ]);
  });

  it("presses a group's Add affordance once and scopes by the named group", async () => {
    const fake = fakePage();
    const ctx = context(fake);
    await driveRow(ctx, row("c.nose.shoulder.length"));
    await driveRow(ctx, row("c.nose.shoulder.od"));
    expect(fake.log.filter((l) => l === "click button:Add shoulder")).toHaveLength(1);
    expect(fake.log).toContain("fill(20) label:Length");
    expect(fake.log).toContain("fill(23) label:Outer diameter");
  });

  it("presses a repeated Add once per part, not once for all parts", async () => {
    const fake = fakePage();
    fake.units.set("label:Roughness", "µm");
    const ctx = context(fake);
    await driveRow(ctx, row("c.nose.finish.roughness"));
    await driveRow(ctx, row("c.body.finish.roughness"));
    expect(fake.log.filter((l) => l === "click button:Custom roughness")).toHaveLength(2);
  });

  it("selects options and ticks boxes by their visible words", async () => {
    const fake = fakePage();
    const ctx = context(fake);
    await driveRow(ctx, row("c.nose.shape"));
    await driveRow(ctx, row("c.nose.shoulder.capped"));
    await driveRow(ctx, row("config.deploy.chute.event"));
    expect(fake.log).toContain("select(Ogive) label:Shape");
    expect(fake.log).toContain("check label:Capped");
    expect(fake.log).toContain("select(Ejection) label:Deploys");
  });

  it("adds a part through its palette tile with the Attach to choice", async () => {
    const fake = fakePage();
    const ctx = context(fake);
    await driveRow(ctx, row("c.body.type"));
    expect(fake.log).toEqual(expect.arrayContaining(["click button:Add part", "select(Nose cone) label:Attach to", "click button:Body tube"]));
  });

  it("fails a control whose label text is not visible, even with an accessible name", async () => {
    const fake = fakePage();
    fake.missing.add("text:Length");
    await expect(driveRow(context(fake), row("c.nose.length"))).rejects.toThrow(/not-found: part "Nose cone", label "Length"/);
  });

  it("takes a table row's label from its visible column header", async () => {
    const fake = fakePage();
    fake.missing.add("columnheader:Deploys");
    await expect(driveRow(context(fake), row("config.deploy.chute.event"))).rejects.toThrow(/not-found: part "Parachute", label "Deploys"/);
  });

  it("reports wrong-unit when the shown unit is another", async () => {
    const fake = fakePage();
    fake.units.set("label:Length", "in");
    await expect(driveRow(context(fake), row("c.nose.length"))).rejects.toThrow(/wrong-unit: part "Nose cone", label "Length"/);
  });

  it("does not accept mm for a row that shows m", async () => {
    const fake = fakePage();
    fake.units.set("label:Rail length", "mm");
    await expect(driveRow(context(fake), row("sim.launch.rail_length"))).rejects.toThrow(/wrong-unit/);
  });

  it("reports not-found for a label that is not visible, and for a tab that is not there", async () => {
    const hidden = fakePage();
    hidden.missing.add("label:Span");
    await expect(driveRow(context(hidden), row("c.fins.span"))).rejects.toThrow(/not-found: part "Trapezoidal fin set", label "Span"/);
    const noTab = fakePage();
    noTab.missing.add("tab:Position");
    await expect(driveRow(context(noTab), row("c.body.attach.to"))).rejects.toThrow(/not-found: part "Body tube", label "Attach to"/);
  });
});

describe("progress.json", () => {
  it("records each row's status and counts them", () => {
    const dir = mkdtempSync(join(SCRATCH, "rw-case1-progress-"));
    try {
      const statuses = new Map<string, RowStatus>([
        ["c.nose.length", "reached"],
        ["c.nose.od", "wrong-unit"],
        ["c.body.length", "not-found"],
      ]);
      const path = join(dir, "b1/progress.json");
      writeProgress(buildProgress(rows, statuses), path);
      const out = JSON.parse(readFileSync(path, "utf8")) as ReturnType<typeof buildProgress>;
      expect(out.counts).toEqual({ reached: 1, "wrong-unit": 1, "not-found": 1, pending: rows.length - 3 });
      expect(out.rows.find((r) => r.key === "c.nose.od")).toMatchObject({ status: "wrong-unit", part: "Nose cone", label: "Outer diameter" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
