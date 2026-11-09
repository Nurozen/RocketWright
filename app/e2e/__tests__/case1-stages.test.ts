/** The ratchet and the row driver, on a fake page that answers by accessible name. */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Expect, Locator, Page } from "@playwright/test";
import { describe, expect, it } from "vitest";
import { buildProgress, writeProgress } from "../case1-progress.ts";
import { boundRows, type BoundRow } from "../case1-script.ts";
import { B1_STAGES, STAGE_IDS, STAGE_NEEDS, driveRow, enabledRowKeys, runStages, validateStages, type DriveContext, type RowStatus, type StageId } from "../case1-stages.ts";
import { SCRATCH } from "../live.ts";

interface Fake {
  page: Page;
  log: string[];
  missing: Set<string>;
  units: Map<string, string>;
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
    allInnerTexts: async () => [],
  } as unknown as Locator;
}

function fakePage(): Fake {
  const fake: Fake = { page: null as unknown as Page, log: [], missing: new Set(), units: new Map() };
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
      toHaveAccessibleDescription: async (re: RegExp) => {
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

describe("the ratchet", () => {
  it("B1_STAGES is consistent: a stage cannot run ahead of what it needs", () => {
    expect(validateStages(B1_STAGES)).toEqual([]);
  });

  it("fails a stage enabled without one it needs", () => {
    expect(validateStages(new Set<StageId>(["launch", "welcome", "new", "fields"]))).toEqual(expect.arrayContaining([expect.stringContaining("stage fields is enabled but others")]));
    expect(validateStages(new Set<StageId>(["run"]))).toHaveLength(STAGE_NEEDS.run.length);
    expect(validateStages(new Set<StageId>(STAGE_IDS))).toEqual([]);
  });

  it("declares needs only on stages that run earlier", () => {
    for (const id of STAGE_IDS) {
      for (const need of STAGE_NEEDS[id]) expect(STAGE_IDS.indexOf(need), `${id} needs ${need}`).toBeLessThan(STAGE_IDS.indexOf(id));
    }
  });

  it("keeps the plan's stage order", () => {
    expect(STAGE_IDS.slice(STAGE_IDS.indexOf("materials"))).toEqual(["materials", "nose", "body", "others", "block", "fields", "motor", "deploy", "sim", "run", "quit", "reopen", "compare"]);
  });

  it("refuses to run an inconsistent set, and runs enabled stages in the fixed order", async () => {
    const fake = fakePage();
    const ctx = context(fake);
    await expect(runStages(ctx, new Set<StageId>(["fields"]))).rejects.toThrow(/fields is enabled but/);
    await runStages(ctx, new Set<StageId>(["launch", "welcome", "new", "nose", "body", "quit", "reopen", "compare"]));
    expect(ctx.statuses.get("c.nose.length")).toBe("reached");
    expect(ctx.statuses.get("c.body.od")).toBe("reached");
    expect(ctx.statuses.get("c.fins.span")).toBe("pending");
    const clicks = fake.log.filter((l) => l.startsWith("click tab:Design") || l.includes("Nose cone") || l.includes("Create project"));
    expect(clicks[0]).toMatch(/Create project/);
    const addNose = fake.log.findIndex((l) => l.includes("button:Nose cone"));
    const addBody = fake.log.findIndex((l) => l.includes("button:Body tube"));
    expect(addNose).toBeGreaterThanOrEqual(0);
    expect(addNose).toBeLessThan(addBody);
  });

  it("marks the failing row, names part and label, and stops at the failing stage", async () => {
    const fake = fakePage();
    fake.missing.add("label:Length");
    const ctx = context(fake);
    await expect(runStages(ctx, new Set<StageId>(["launch", "welcome", "new", "nose", "body"]))).rejects.toThrow(/not-found: part "Nose cone", label "Length"/);
    expect(ctx.statuses.get("c.nose.length")).toBe("not-found");
    expect(ctx.statuses.get("c.nose.od")).toBe("reached");
    expect(ctx.statuses.get("c.body.type")).toBe("pending");
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
      writeProgress(buildProgress(rows, statuses, new Set<StageId>(["launch"])), path);
      const out = JSON.parse(readFileSync(path, "utf8")) as ReturnType<typeof buildProgress>;
      expect(out.counts).toEqual({ reached: 1, "wrong-unit": 1, "not-found": 1, pending: rows.length - 3 });
      expect(out.enabled).toEqual(["launch"]);
      expect(out.rows.find((r) => r.key === "c.nose.od")).toMatchObject({ status: "wrong-unit", part: "Nose cone", label: "Outer diameter" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("enabledRowKeys covers only the enabled stages", () => {
    const keys = enabledRowKeys(new Set<StageId>(["nose"]));
    expect(keys.has("c.nose.length")).toBe(true);
    expect(keys.has("c.body.length")).toBe(false);
  });
});
