/** B3 `s-new-project`: Welcome on the seeded profile, then its New project button. */
import { settle, waitFor, type DriveContext } from "../hooks.ts";
import { clickButton, welcomeWithRecents } from "./common.ts";

function dialogName(): string | null {
  const dialog = document.querySelector('[role="dialog"]');
  const labelled = dialog === null ? null : document.getElementById(dialog.getAttribute("aria-labelledby") ?? "");
  return labelled?.textContent?.trim() ?? null;
}

export default async function drive({ page }: DriveContext): Promise<unknown> {
  await welcomeWithRecents(page);
  await clickButton(page, "New project");
  await waitFor(page, "the New project dialog", () => document.querySelector('[role="dialog"]') !== null, null);
  const dialog = await page.evaluate(dialogName, null);
  if (dialog !== "New project") throw new Error(`capture: opened a dialog named ${String(dialog)}`);
  await settle(page);
  return { state: { dialog } };
}
