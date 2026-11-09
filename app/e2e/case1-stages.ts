/**
 * The B1 drive. Every control is found the way a person finds it, by visible
 * label and role through visible navigation (D27). This file and the spec are
 * source-scanned: only the calls that scan allows may appear here
 * (`__tests__/case1-scan.test.ts`), so lifecycle work (launching, quitting, the
 * post-quit reads) comes in through `Lifecycle`.
 *
 * Every stage is required, in this order: there is no partial rebuild to pass.
 */
import type { Expect, Locator, Page } from "@playwright/test";
import type { TableCell, TableRead } from "./case1-compare.ts";
import { boundRows, typedValue, type BoundRow } from "./case1-script.ts";

export const STAGE_IDS = ["launch", "welcome", "choose", "new", "materials", "nose", "body", "others", "block", "fields", "motor", "deploy", "sim", "run", "quit", "reopen", "compare"] as const;
export type StageId = (typeof STAGE_IDS)[number];

export type RowStatus = "reached" | "not-found" | "wrong-unit" | "pending";

/** A row the drive could not complete, naming the part and label. */
export class RowFailure extends Error {
  readonly status: "not-found" | "wrong-unit";

  constructor(status: "not-found" | "wrong-unit", row: BoundRow, detail: string) {
    super(`${status}: part "${row.part ?? row.dialog ?? "-"}", label "${row.label}" (${row.key}): ${detail}`);
    this.status = status;
  }
}

/** Everything that is not a human control: the spec implements it, outside this scan. */
export interface Lifecycle {
  /** The app's folder choice for the Location picker: stubs the native dialog and returns the path. */
  chooseFolder(): Promise<string>;
  /** Quits the app. */
  quit(): Promise<void>;
  /** Launches it again on the same profile and returns the new window. */
  relaunch(): Promise<Page>;
  /** Final quit, kills what this run started and quit left, then the post-quit comparison and run scoring. */
  finish(drive: DriveContext): Promise<void>;
}

export interface DriveContext {
  page: Page;
  expect: Expect;
  lifecycle: Lifecycle;
  /** The name typed in New project: reopen must show this project, not just any Design tab. */
  projectName: string;
  statuses: Map<string, RowStatus>;
  /** Parts' Add affordances already pressed. */
  added: Set<string>;
  timeouts: { row: number; launch: number; run: number };
  /** `Date.now()` before the Run click and at quit (D29). */
  timing: { runClickedAt?: number; quitAt?: number };
  /** The Results row as read in `run`, then in `reopen`. */
  tableReads: TableRead[];
}

const exactly = (name: string) => ({ name, exact: true });

/** A tree row by the name it shows: not a row whose name continues with a number (`Centering ring 2`). */
const treeName = (name: string) => new RegExp(`${name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}(?! \\d)`, "i");

async function navigate(ctx: DriveContext, row: BoundRow): Promise<void> {
  const { page } = ctx;
  if (row.page !== undefined) await page.getByRole("tab", exactly(row.page)).click();
  if (row.local !== undefined) await page.getByRole("tab", exactly(row.local)).click();
  if (row.local === "Components" && row.part !== undefined && row.control !== "add-part" && row.control !== "material") {
    await page.getByRole("treeitem", { name: treeName(row.part) }).first().click();
  }
  if (row.tab !== undefined) await page.getByRole("tab", exactly(row.tab)).click();
}

/** Where the row's label is looked up: its dialog, its table row, then its named group. */
function scopeOf(page: Page, row: BoundRow): Page | Locator {
  let scope: Page | Locator = page;
  if (row.dialog !== undefined) scope = page.getByRole("dialog", { name: row.dialog });
  if (row.inRow === true && row.part !== undefined) scope = scope.getByRole("row", { name: row.part });
  if (row.group !== undefined) scope = scope.getByRole("group", exactly(row.group));
  return scope;
}

async function pressAdd(ctx: DriveContext, row: BoundRow): Promise<void> {
  if (row.add === undefined) return;
  const once = `${row.part ?? ""}/${row.add}`;
  if (row.control !== "material" && ctx.added.has(once)) return;
  await ctx.page.getByRole("button", exactly(row.add)).click();
  ctx.added.add(once);
}

async function addPart(ctx: DriveContext, row: BoundRow): Promise<void> {
  const { page } = ctx;
  await page.getByRole("button", exactly("Add part")).click();
  // Inside the popover: the viewport labels parts with buttons, and the editor has its own Attach to.
  const palette = page.getByRole("dialog", exactly("Add part"));
  if (row.attachTo !== undefined) await palette.getByLabel("Attach to", { exact: true }).selectOption({ label: row.attachTo });
  await palette.getByRole("button", exactly(row.label)).click();
}

async function assignMotor(ctx: DriveContext, row: BoundRow): Promise<void> {
  const { page } = ctx;
  await page.getByLabel(row.label, { exact: true }).fill(row.option ?? "");
  // The row in the Motors list: its own About button also names the motor, and picks nothing.
  await page.getByRole("listbox", exactly("Motors")).getByRole("option", { name: row.option ?? "" }).first().click();
  await page.getByRole("button", exactly("Assign to configuration")).click();
}

/** A unit as a whole token of the description: `mm` does not satisfy `m`. */
const unitPattern = (unit: string) => new RegExp(`(^|\\s)${unit.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}(\\s|$)`);

async function assertLabelAndUnit(ctx: DriveContext, scope: Page | Locator, input: Locator, row: BoundRow): Promise<void> {
  const timeout = ctx.timeouts.row;
  // The words themselves must show: an `aria-label` alone would let a control pass that no person can read.
  // A control in a table row takes its label from its visible column header (U27).
  const words = row.inRow === true ? ctx.page.getByRole("columnheader", exactly(row.label)) : scope.getByText(row.label, { exact: true }).first();
  await ctx.expect(words).toBeVisible({ timeout });
  await ctx.expect(input).toBeVisible({ timeout });
  if (row.unit === undefined) return;
  try {
    await ctx.expect(input).toHaveAccessibleDescription(unitPattern(row.unit), { timeout });
  } catch (e) {
    throw new RowFailure("wrong-unit", row, `expected the unit ${row.unit} beside the value: ${String(e)}`);
  }
}

async function enterField(ctx: DriveContext, row: BoundRow): Promise<void> {
  const scope = scopeOf(ctx.page, row);
  if (row.turnOff !== undefined) {
    const box = scope.getByRole("checkbox", exactly(row.turnOff));
    await box.click();
    await ctx.expect(box).toBeChecked({ checked: false, timeout: ctx.timeouts.row });
  }
  // Unscoped rows take the first match: the part's own field comes before its nested groups.
  const input = row.group === undefined && row.dialog === undefined && row.inRow !== true ? scope.getByLabel(row.label, { exact: true }).first() : scope.getByLabel(row.label, { exact: true });
  await assertLabelAndUnit(ctx, scope, input, row);
  if (row.control === "select") {
    await input.selectOption({ label: row.option ?? "" });
  } else if (row.control === "check") {
    await input.check();
  } else {
    await input.fill(typedValue(row));
    await input.press("Tab");
  }
}

/** Reaches one row and types its value. Throws `RowFailure`, naming part and label. */
export async function driveRow(ctx: DriveContext, row: BoundRow): Promise<void> {
  try {
    await navigate(ctx, row);
    await pressAdd(ctx, row);
    if (row.control === "add-part") await addPart(ctx, row);
    else if (row.control === "motor") await assignMotor(ctx, row);
    else if (row.control === "material") {
      await ctx.page.getByLabel("Name", { exact: true }).first().fill(row.material ?? "");
      await enterField(ctx, row);
    } else await enterField(ctx, row);
  } catch (e) {
    if (e instanceof RowFailure) throw e;
    throw new RowFailure("not-found", row, String(e));
  }
}

/** Drives a stage's rows, in script order. Every row is tried, so `progress.json` shows the whole gap. */
async function driveRows(ctx: DriveContext, stage: StageId, rows: readonly BoundRow[]): Promise<void> {
  const failures: string[] = [];
  for (const row of rows) {
    if (row.stage !== stage) continue;
    try {
      await driveRow(ctx, row);
      ctx.statuses.set(row.key, "reached");
    } catch (e) {
      if (!(e instanceof RowFailure)) throw e;
      ctx.statuses.set(row.key, e.status);
      failures.push(e.message);
    }
  }
  if (failures.length > 0) throw new Error(`stage ${stage} failed:\n${failures.join("\n")}`);
}

/** A cell by its column's position under the header that says what it is. */
function cellUnder(headers: readonly string[], cells: readonly string[], header: RegExp): TableCell {
  const i = headers.findIndex((h) => header.test(h));
  const shown = i < 0 ? undefined : cells[i];
  if (shown === undefined) throw new Error(`the Results table has no column matching ${header.source}`);
  return { header: headers[i]!, shown };
}

async function readRunRow(page: Page, row: Locator): Promise<TableRead> {
  const headers = await page.getByRole("columnheader").allInnerTexts();
  const cells = await row.getByRole("cell").allInnerTexts();
  return {
    apogee: cellUnder(headers, cells, /^\s*Apogee\b/),
    maxSpeed: cellUnder(headers, cells, /^\s*Max speed\b/),
    flightTime: cellUnder(headers, cells, /^\s*Flight time\b/),
  };
}

const notRunRow = (page: Page) => page.getByRole("row", { name: /Not run/ });
const completeRow = (page: Page) => page.getByRole("row", { name: /Complete/ });

type StageBody = (ctx: DriveContext, rows: readonly BoundRow[]) => Promise<void>;

const onlyRows =
  (stage: StageId): StageBody =>
  (ctx, rows) =>
    driveRows(ctx, stage, rows);

const STAGE_BODIES: Readonly<Record<StageId, StageBody>> = {
  async launch(ctx) {
    await ctx.expect(ctx.page.getByRole("button", exactly("New project"))).toBeVisible({ timeout: ctx.timeouts.launch });
  },
  async welcome(ctx) {
    await ctx.page.getByRole("button", exactly("New project")).click();
    await ctx.expect(ctx.page.getByRole("dialog", { name: "New project" })).toBeVisible({ timeout: ctx.timeouts.row });
  },
  async choose(ctx) {
    const dialog = ctx.page.getByRole("dialog", { name: "New project" });
    const folder = await ctx.lifecycle.chooseFolder();
    await dialog.getByRole("button", exactly("Choose")).click();
    await ctx.expect(dialog.getByText(folder)).toBeVisible({ timeout: ctx.timeouts.row });
  },
  async new(ctx, rows) {
    await driveRows(ctx, "new", rows);
    const dialog = ctx.page.getByRole("dialog", { name: "New project" });
    await dialog.getByRole("radio", { name: /Empty/ }).check();
    await dialog.getByRole("button", exactly("Create project")).click();
    await ctx.expect(ctx.page.getByRole("tab", exactly("Design"))).toBeVisible({ timeout: ctx.timeouts.launch });
  },
  materials: onlyRows("materials"),
  nose: onlyRows("nose"),
  body: onlyRows("body"),
  others: onlyRows("others"),
  block: onlyRows("block"),
  fields: onlyRows("fields"),
  motor: onlyRows("motor"),
  deploy: onlyRows("deploy"),
  async sim(ctx, rows) {
    const { page, expect } = ctx;
    await page.getByRole("tab", exactly("Results")).click();
    await page.getByRole("button", exactly("New simulation")).click();
    const sheet = page.getByRole("dialog", { name: "Simulation conditions" });
    const field = (group: string, label: string) => sheet.getByRole("group", exactly(group)).getByLabel(label, { exact: true });
    // Exact: "Save and run" contains "Save", and this stage must fly nothing (D23).
    const save = async () => {
      await sheet.getByRole("button", exactly("Save")).click();
      await expect(sheet).toBeHidden({ timeout: ctx.timeouts.row });
      await expect(notRunRow(page)).toBeVisible({ timeout: ctx.timeouts.row });
    };
    // Off the defaults first, then read back through the row: a Save that never reached the model fails here (D23).
    await field("Launch", "Rail length").fill("2.5");
    await field("Wind", "Speed").fill("4");
    await save();
    await notRunRow(page).getByRole("button", { name: /actions$/ }).click();
    await page.getByRole("menuitem", exactly("Simulation conditions")).click();
    await expect(field("Launch", "Rail length")).toHaveValue("2.5", { timeout: ctx.timeouts.row });
    await expect(field("Wind", "Speed")).toHaveValue("4", { timeout: ctx.timeouts.row });
    await driveRows(ctx, "sim", rows);
    await save();
  },
  async run(ctx) {
    const { page } = ctx;
    await page.getByRole("tab", exactly("Results")).click();
    const row = notRunRow(page);
    await ctx.expect(row).toBeVisible({ timeout: ctx.timeouts.row });
    ctx.timing.runClickedAt = Date.now();
    await row.getByRole("button", exactly("Run")).click();
    await ctx.expect(completeRow(page)).toBeVisible({ timeout: ctx.timeouts.run });
    ctx.tableReads.push(await readRunRow(page, completeRow(page)));
  },
  async quit(ctx) {
    ctx.timing.quitAt = Date.now();
    await ctx.lifecycle.quit();
  },
  async reopen(ctx) {
    ctx.page = await ctx.lifecycle.relaunch();
    await ctx.expect(ctx.page.getByRole("tab", exactly("Design"))).toBeVisible({ timeout: ctx.timeouts.launch });
    await ctx.expect(ctx.page.getByRole("button", { name: ctx.projectName })).toBeVisible({ timeout: ctx.timeouts.row });
    if (ctx.tableReads.length === 0) return;
    await ctx.page.getByRole("tab", exactly("Results")).click();
    await ctx.expect(completeRow(ctx.page)).toBeVisible({ timeout: ctx.timeouts.row });
    const again = await readRunRow(ctx.page, completeRow(ctx.page));
    if (JSON.stringify(again) !== JSON.stringify(ctx.tableReads[0])) {
      throw new Error(`reopen: the Results table changed: ${JSON.stringify(ctx.tableReads[0])} then ${JSON.stringify(again)}`);
    }
    ctx.tableReads.push(again);
  },
  async compare(ctx) {
    await ctx.lifecycle.finish(ctx);
  },
};

/**
 * Runs every stage in the fixed order. Rows a failed stage never reached stay
 * `pending`. Write `progress.json` from `ctx.statuses` in a `finally`: the
 * first failing stage throws.
 */
export async function runStages(ctx: DriveContext, rows: readonly BoundRow[] = boundRows()): Promise<void> {
  for (const row of rows) ctx.statuses.set(row.key, "pending");
  for (const id of STAGE_IDS) {
    const body = STAGE_BODIES[id];
    await body(ctx, rows);
  }
}
