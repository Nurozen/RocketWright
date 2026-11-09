/**
 * B3 `s-sim-conditions`: the sample rocket on Results, its never-flown sims
 * reading Not run, then the row clicked the way a person opens a sim's
 * conditions. Nothing is flown: the sheet is what this capture shows.
 */
import { requireEmbed, settle, waitFor, type DriveContext } from "../hooks.ts";

const SHEET = '[data-testid="sim-conditions"]';

interface SheetState {
  title: string | null;
  groups: string[];
  actions: string[];
  rail: string | null;
  units: string[];
}

function readSheet(selector: string): SheetState | null {
  const sheet = document.querySelector<HTMLElement>(selector);
  if (sheet === null) return null;
  const rail = [...sheet.querySelectorAll<HTMLInputElement>("input")].find((i) => i.getAttribute("aria-label") === "Rail length");
  return {
    title: document.getElementById(sheet.getAttribute("aria-labelledby") ?? "")?.textContent?.trim() ?? null,
    groups: [...sheet.querySelectorAll('[role="group"] h3')].map((h) => h.textContent?.trim() ?? ""),
    actions: [...sheet.querySelectorAll(".rw-ui-sheet__footer button")].map((b) => b.textContent?.trim() ?? "").filter((t) => t !== ""),
    rail: rail?.value ?? null,
    units: [...sheet.querySelectorAll(".rw-field__unit")].map((u) => u.textContent?.trim() ?? "").filter((u) => u !== ""),
  };
}

export default async function drive({ page, paneReady }: DriveContext): Promise<unknown> {
  await requireEmbed(page);
  const unready = (await paneReady?.()) ?? null;
  if (unready !== null) throw new Error(`capture: ${unready}`);
  await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => t.textContent?.trim() === "Results")?.click(), null);
  await waitFor(page, "a never-flown sim on Results", () => document.querySelector('[data-testid="runs.table-row"][data-status="not_run"]') !== null, null);
  const row = await page.evaluate(() => {
    const target = document.querySelector<HTMLElement>('[data-testid="runs.table-row"][data-status="not_run"]');
    const run = [...(target?.querySelectorAll("button") ?? [])].some((b) => b.textContent?.trim() === "Run");
    target?.querySelector<HTMLElement>(".rw-runtable__name")?.click();
    return { status: target?.querySelector('[data-testid="runs.status"]')?.textContent?.trim() ?? null, run };
  }, null);
  if (row.status !== "Not run" || !row.run) throw new Error(`capture: the row reads ${String(row.status)}, Run button ${String(row.run)}`);
  await waitFor(page, "the Simulation conditions sheet", (selector: string) => document.querySelector(selector) !== null, SHEET);
  const sheet = await page.evaluate(readSheet, SHEET);
  if (sheet === null) throw new Error("capture: the sheet closed");
  if (sheet.title?.startsWith("Simulation conditions: ") !== true) throw new Error(`capture: the sheet is titled ${String(sheet.title)}`);
  if (sheet.groups.join() !== "Launch,Site,Wind,Atmosphere,Solver") throw new Error(`capture: groups are ${sheet.groups.join()}`);
  if (sheet.actions.join() !== "Revert,Save,Save and run") throw new Error(`capture: actions are ${sheet.actions.join()}`);
  if (sheet.rail === null || sheet.rail === "") throw new Error("capture: no Rail length value");
  await settle(page);
  return { state: { ...sheet, row } };
}
