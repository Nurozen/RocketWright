/** U48 `s-context-menu`: the sample rocket open, then a right-click on a nested part in the Components tree. */
import { requireEmbed, settle, waitFor, type DriveContext } from "../hooks.ts";

const MENU = '[data-testid="tree.context-menu.list"]';

interface MenuState {
  items: string[];
  dangerous: string[];
}

function readMenu(selector: string): MenuState | null {
  const list = document.querySelector(selector);
  if (list === null) return null;
  const items = [...list.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  return {
    items: items.map((i) => i.textContent?.trim() ?? ""),
    dangerous: items.filter((i) => i.dataset["danger"] === "true").map((i) => i.textContent?.trim() ?? ""),
  };
}

export default async function drive({ page, paneReady }: DriveContext): Promise<unknown> {
  await requireEmbed(page);
  const unready = (await paneReady?.()) ?? null;
  if (unready !== null) throw new Error(`capture: ${unready}`);
  await waitFor(page, "the parts tree", () => document.querySelectorAll('[role="treeitem"]').length > 0, null);
  const part = await page.evaluate(() => {
    const row = [...document.querySelectorAll<HTMLElement>('[role="treeitem"][data-depth="1"]')].find((r) => r.getClientRects().length > 0);
    if (row === undefined) return null;
    const box = row.getBoundingClientRect();
    row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 }));
    return row.textContent?.trim() ?? "";
  }, null);
  if (part === null) throw new Error("capture: no visible nested part in the tree");
  await waitFor(page, "the part's context menu", (selector: string) => document.querySelector(selector) !== null, MENU);
  const menu = await page.evaluate(readMenu, MENU);
  if (menu === null) throw new Error("capture: the context menu closed");
  if (menu.items.join() !== "Rename,Duplicate,Move to,Delete") throw new Error(`capture: the menu offers ${menu.items.join()}`);
  if (menu.dangerous.join() !== "Delete") throw new Error(`capture: drawn in the danger colour: ${menu.dangerous.join()}`);
  await settle(page);
  return { state: { part, menu } };
}
