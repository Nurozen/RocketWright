/** B3 `s-add-part`: the sample rocket open, then a click on the Components rail's "+". */
import { requireEmbed, settle, waitFor, type DriveContext } from "../hooks.ts";

interface PaletteState {
  dialog: string | null;
  tabs: string[];
  attachTo: string | null;
  tiles: number;
  columns: number;
}

function readPalette(): PaletteState | null {
  const popover = document.querySelector<HTMLElement>('[data-testid="add-part.popover"]');
  if (popover === null) return null;
  const select = popover.querySelector<HTMLSelectElement>("select");
  const grid = popover.querySelector<HTMLElement>(".rw-add-part__grid");
  return {
    dialog: document.getElementById(popover.getAttribute("aria-labelledby") ?? "")?.textContent?.trim() ?? null,
    tabs: [...popover.querySelectorAll('[role="tab"]')].map((t) => t.textContent?.trim() ?? ""),
    attachTo: select?.selectedOptions[0]?.textContent?.trim() ?? null,
    tiles: popover.querySelectorAll(".rw-add-part__tile").length,
    columns: grid === null ? 0 : getComputedStyle(grid).gridTemplateColumns.split(" ").length,
  };
}

export default async function drive({ page, paneReady }: DriveContext): Promise<unknown> {
  await requireEmbed(page);
  const unready = (await paneReady?.()) ?? null;
  if (unready !== null) throw new Error(`capture: ${unready}`);
  await waitFor(page, "the parts tree", () => document.querySelectorAll('[role="treeitem"]').length > 0, null);
  const clicked = await page.evaluate(() => {
    const plus = [...document.querySelectorAll<HTMLElement>('button[aria-label="Add part"]')].find((b) => b.getClientRects().length > 0);
    plus?.click();
    return plus !== undefined;
  }, null);
  if (!clicked) throw new Error("capture: no visible Add part button");
  await waitFor(page, "the Add part popover", () => document.querySelector('[data-testid="add-part.popover"]') !== null, null);
  const palette = await page.evaluate(readPalette, null);
  if (palette === null) throw new Error("capture: the Add part popover closed");
  if (palette.dialog !== "Add part") throw new Error(`capture: opened a dialog named ${String(palette.dialog)}`);
  if (palette.tabs.join() !== "Part types,Parts library") throw new Error(`capture: tabs are ${palette.tabs.join()}`);
  if (palette.attachTo === null) throw new Error("capture: no Attach to choice");
  if (palette.tiles !== 19 || palette.columns !== 4) throw new Error(`capture: ${palette.tiles} tiles in ${palette.columns} columns`);
  await settle(page);
  return { state: palette };
}
