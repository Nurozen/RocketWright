/**
 * B3 `s-check-issues`: the sample rocket with one fit error and two warnings,
 * Check model clicked, and the error's Go to part pressed so its part is
 * outlined under the panel. The edits go through `model.patch` like any other
 * model change, since the sample checks clean; everything after that is a click.
 */
import { Hooks, requireEmbed, settle, waitFor, type DriveContext } from "../hooks.ts";

const PANEL = '[data-testid="header.check-issues"]';

/** The nose shoulder no longer fits the recovery bay (RW-E150); a shear-pin joint without a count and a fin tab shallower than the wall warn. */
const BREAK_THE_MODEL = [
  { op: "replace", path: "/c/nose/shoulder/od", value: "53.5 mm" },
  { op: "replace", path: "/c/recovery_bay/joint", value: { type: "shear_pin" } },
  { op: "add", path: "/c/fins/tab", value: { height: "0.2 mm", length: "60 mm" } },
];

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

export default async function drive({ page, rpcUrl, paneReady }: DriveContext): Promise<unknown> {
  await requireEmbed(page);
  const unready = (await paneReady?.()) ?? null;
  if (unready !== null) throw new Error(`capture: ${unready}`);
  const hooks = await Hooks.open(rpcUrl);
  try {
    await hooks.rpc("model.patch", { ops: BREAK_THE_MODEL as never, label: "Check issues fixture" });
  } finally {
    hooks.close();
  }
  await waitFor(page, "the injected issues in the header", () => document.querySelector('[data-testid="header.check-model"]')?.getAttribute("data-check-status") === "errors", null);
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
  if (state.errors !== 1 || state.warnings !== 2 || state.goto !== 3) throw new Error(`capture: expected one error, two warnings and three Go to part buttons, got ${JSON.stringify(state)}`);
  await page.evaluate((selector: string) => {
    const row = document.querySelector(`${selector} [data-severity="error"]`);
    [...(row?.querySelectorAll("button") ?? [])].find((b) => b.textContent?.trim() === "Go to part")?.click();
  }, PANEL);
  await waitFor(page, "the part selected in the viewport", () => document.querySelector('[data-selected="nose"]') !== null, null);
  await settle(page);
  return { state };
}
