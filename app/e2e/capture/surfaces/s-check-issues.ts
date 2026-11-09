/**
 * B3 `s-check-issues`: the research vehicle with one injected fit error and the
 * vehicle's own warnings, Check model clicked, and the error's Go to part pressed
 * so its part is outlined under the panel. The broken project is written before
 * launch (`seed` in `tests/bar/surfaces.json`), since captures run the real app
 * with no test hooks; everything here is a click.
 */
import { requireEmbed, settle, waitFor, type DriveContext } from "../hooks.ts";

const PANEL = '[data-testid="header.check-issues"]';

interface PanelState {
  errors: number;
  warnings: number;
  goto: number;
  again: boolean;
}

function readPanel(selector: string): PanelState | null {
  const panel = document.querySelector(selector);
  if (panel === null) return null;
  const buttons = [...panel.querySelectorAll("button")];
  const again = buttons.find((b) => b.textContent?.trim() === "Run check again");
  return {
    errors: panel.querySelectorAll('[data-severity="error"]').length,
    warnings: panel.querySelectorAll('[data-severity="warning"]').length,
    goto: buttons.filter((b) => b.textContent?.trim() === "Go to part").length,
    again: again !== undefined && !again.disabled,
  };
}

export default async function drive({ page, paneReady }: DriveContext): Promise<unknown> {
  await requireEmbed(page);
  const unready = (await paneReady?.()) ?? null;
  if (unready !== null) throw new Error(`capture: ${unready}`);
  await waitFor(page, "the seeded issues in the header", () => document.querySelector('[data-testid="header.check-model"]')?.getAttribute("data-check-status") === "errors", null);
  await page.evaluate(() => document.querySelector<HTMLElement>('[data-testid="header.check-model"]')?.click(), null);
  await waitFor(
    page,
    "the finished check in the panel",
    (selector: string) => {
      const again = [...(document.querySelector(selector)?.querySelectorAll("button") ?? [])].find((b) => b.textContent?.trim() === "Run check again");
      return again !== undefined && !again.disabled;
    },
    PANEL,
  );
  const state = await page.evaluate(readPanel, PANEL);
  if (state === null) throw new Error("capture: the Check model panel closed");
  if (state.errors !== 1 || state.warnings !== 3 || state.goto !== 2) throw new Error(`capture: expected one error, three warnings and two Go to part buttons, got ${JSON.stringify(state)}`);
  await page.evaluate((selector: string) => {
    const row = document.querySelector(`${selector} [data-severity="error"]`);
    [...(row?.querySelectorAll("button") ?? [])].find((b) => b.textContent?.trim() === "Go to part")?.click();
  }, PANEL);
  await waitFor(page, "the part selected in the viewport", () => document.querySelector('[data-selected="nose"]') !== null, null);
  await settle(page);
  return { state };
}
