/**
 * B3 `s-liquid-editor`: the sample rocket's demo engine on Propulsion's
 * Properties tab, with a design input changed through its spinner so the
 * page reads Modified, needs recompute beside the last result. Every step
 * is a click on a visible control.
 */
import { requireEmbed, settle, waitFor, type DriveContext } from "../hooks.ts";

interface EditorState {
  cards: string[];
  actions: string[];
  modified: string | null;
  results: string[];
  compute: boolean;
  stale: boolean;
}

function readEditor(): EditorState {
  const editor = document.querySelector('[data-testid="liquid.editor"]');
  return {
    cards: [...(editor?.querySelectorAll(":scope > .rw-liq-editor__grid > [role=\"group\"] > h3") ?? [])].map((h) => h.textContent?.trim() ?? ""),
    actions: [...(editor?.querySelectorAll(".rw-liq-editor__actions button") ?? [])].map((b) => b.textContent?.trim() ?? ""),
    modified: document.querySelector('[data-testid="liquid.modified"]')?.textContent?.trim() ?? null,
    results: [...document.querySelectorAll('[data-testid="liquid.results"] [data-stat]')].map((s) => s.querySelector("dt")?.textContent?.trim() ?? ""),
    compute: document.querySelector<HTMLButtonElement>('[data-testid="liquid.compute"]')?.disabled === false,
    stale: document.querySelector('[data-testid="liquid.results"]')?.getAttribute("data-stale") === "true",
  };
}

export default async function drive({ page, paneReady }: DriveContext): Promise<unknown> {
  await requireEmbed(page);
  const unready = (await paneReady?.()) ?? null;
  if (unready !== null) throw new Error(`capture: ${unready}`);
  await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => t.textContent?.trim() === "Propulsion")?.click(), null);
  await waitFor(page, "the Liquid propulsion page", () => document.querySelector('[data-testid="liquid-page"]') !== null, null);
  await waitFor(page, "the sample's engine", () => document.querySelector('[data-testid="liquid-page"]')?.getAttribute("data-engine") === "demo", null);
  await page.evaluate(() => document.querySelector<HTMLElement>('[data-testid="propulsion.tab"][data-group="page"][data-tab="properties"]')?.click(), null);
  await waitFor(page, "the computed design", () => document.querySelector('[data-testid="liquid.properties"]')?.getAttribute("data-state") === "ready", null);
  await waitFor(page, "the Thrust field", () => document.querySelector('[aria-label="Increase Thrust"]') !== null, null);
  await page.evaluate(() => document.querySelector<HTMLElement>('[aria-label="Increase Thrust"]')?.click(), null);
  await waitFor(page, "the Modified line", () => document.querySelector('[data-testid="liquid.modified"]') !== null, null);
  const state = await page.evaluate(readEditor, null);
  if (state.cards.join() !== "Propellants,Chamber,Nozzle,Injector,Tanks") throw new Error(`capture: cards are ${state.cards.join()}`);
  if (!state.actions.includes("New engine") || !state.actions.includes("Duplicate")) throw new Error(`capture: actions are ${state.actions.join()}`);
  if (state.modified !== "Modified, needs recompute" || !state.stale) throw new Error(`capture: the page reads ${String(state.modified)}, stale ${String(state.stale)}`);
  if (state.results.join() !== "Isp,Chamber diameter,Throat diameter" || !state.compute) throw new Error(`capture: the result strip is ${state.results.join()}, Compute ${String(state.compute)}`);
  await settle(page);
  return { state };
}
