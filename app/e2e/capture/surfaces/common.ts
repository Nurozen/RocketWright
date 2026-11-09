/**
 * What the B3 surface drives share. Surfaces are reached the way a person
 * reaches them, by clicking visible controls; a zero-project window has no
 * broker hooks to call (`Hooks.open` needs a project).
 *
 * Every check throws: a capture that did not reach its state must fail, not
 * produce a picture of the wrong state.
 */
import type { PageLike } from "../../regions.ts";
import { waitFor } from "../hooks.ts";

/** Clicks the visible button whose text is exactly `name`. */
export async function clickButton(page: PageLike, name: string): Promise<void> {
  const clicked = await page.evaluate((label: string) => {
    const button = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === label && b.getClientRects().length > 0);
    button?.click();
    return button !== undefined;
  }, name);
  if (!clicked) throw new Error(`capture: no visible button named ${name}`);
}

export interface RecentRow {
  name: string;
  status: string;
}

function welcomeRecents(): RecentRow[] {
  return [...document.querySelectorAll<HTMLElement>(".rw-welcome__recent-row")].map((row) => ({
    name: row.querySelector(".rw-welcome__recent-name")?.textContent?.trim() ?? "",
    status: row.dataset["status"] ?? "",
  }));
}

/** Waits for Welcome and the seeded Recents, and returns the rows. */
export async function welcomeWithRecents(page: PageLike): Promise<RecentRow[]> {
  await waitFor(page, "the Welcome screen", () => document.querySelector('[data-testid="welcome"]') !== null, null);
  await waitFor(page, "three Recent rows", () => document.querySelectorAll(".rw-welcome__recent-row").length === 3, null);
  const rows = await page.evaluate(welcomeRecents, null);
  if (rows.filter((r) => r.status === "missing").length !== 1) throw new Error(`capture: expected one missing Recent, got ${JSON.stringify(rows)}`);
  return rows;
}
