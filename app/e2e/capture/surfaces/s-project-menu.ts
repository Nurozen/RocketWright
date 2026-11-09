/** B3 `s-project-menu`: the sample rocket open with Recents seeded, then a click on the header's project control. */
import { requireEmbed, settle, waitFor, type DriveContext } from "../hooks.ts";

interface MenuState {
  current: string[];
  recents: string[];
  actions: string[];
}

function readMenu(): MenuState | null {
  const list = document.querySelector('[data-testid="header.project-menu.list"]');
  if (list === null) return null;
  const items = [...list.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemcheckbox"]')];
  const label = (el: HTMLElement): string => el.textContent?.trim() ?? "";
  const heading = [...list.querySelectorAll<HTMLElement>(".rw-ui-menu__heading")].find((h) => label(h) === "Recent") ?? null;
  const rows = [...list.children] as HTMLElement[];
  const headingAt = heading === null ? -1 : rows.indexOf(heading);
  const divider = rows.findIndex((r, i) => i > headingAt && r.getAttribute("role") === "separator");
  const recents = headingAt === -1 || divider === -1 ? [] : rows.slice(headingAt + 1, divider).flatMap((r) => [...r.querySelectorAll<HTMLElement>('[role="menuitem"]')].map(label));
  return {
    current: items.filter((i) => i.getAttribute("aria-checked") === "true").map(label),
    recents,
    actions: items.filter((i) => i.getAttribute("role") === "menuitem").map(label).slice(-5),
  };
}

export default async function drive({ page, paneReady }: DriveContext): Promise<unknown> {
  await requireEmbed(page);
  const unready = (await paneReady?.()) ?? null;
  if (unready !== null) throw new Error(`capture: ${unready}`);
  await waitFor(
    page,
    "the project name in the header",
    () => {
      const text = document.querySelector('[data-testid="header.project-switcher"]')?.textContent?.trim() ?? "";
      return text !== "" && text !== "Opening…" && text !== "No project";
    },
    null,
  );
  await page.evaluate(() => document.querySelector<HTMLElement>('[data-testid="header.project-switcher"]')?.click(), null);
  await waitFor(page, "the project menu", () => document.querySelector('[data-testid="header.project-menu.list"]') !== null, null);
  // The menu refreshes Recents when it opens; the seeded rows arrive just after.
  await waitFor(
    page,
    "the seeded Recent rows",
    () => [...document.querySelectorAll('[data-testid="header.project-menu.list"] [role="menuitem"]')].filter((i) => i.textContent?.includes("old-prototype")).length > 0,
    null,
  );
  const menu = await page.evaluate(readMenu, null);
  if (menu === null) throw new Error("capture: the project menu closed");
  if (menu.current.length !== 1) throw new Error(`capture: expected one checked project, got ${JSON.stringify(menu)}`);
  await settle(page);
  return { state: menu };
}
