/**
 * M2.7 Revisions + Compare, live: the web bundle on the app server and
 * sidecar over the seeded research vehicle (global setup;
 * `fixtures/research-vehicle/seed.sh`: 01 Initial concept, 02 Assembly
 * layout = flight computer 20 → 25 mm, 03 Fin revision = fin span 90 → 100
 * mm and sweep 45 → 40 mm, 04 Flight runs = sims and configs only, Rev 07;
 * runs Fin revision on 02 (Outdated), Baseline on 04).
 *
 * The strip's Compare opens the Compare view in the workspace (Backplane
 * compare reference): Old/New pickers over steps, revisions, and runs; the
 * viewport marks changed parts amber with the rest dimmed; the metric table
 * carries units; the legend reads Removed / Changed / Added; Close returns
 * to the page. Revert from the strip menu and from the Compare bar restores
 * a step as a new step (history_restore); the spec reverts back to the
 * latest step so the shared project ends where it began.
 */
import { expect, test, type Page } from "@playwright/test";

const WEB = process.env["RW_E2E_WEB_URL"] ?? "";
const RPC = process.env["RW_E2E_RPC_URL"] ?? "";
const HTTP = process.env["RW_E2E_HTTP_URL"] ?? "";

/** The viewport's mark colours (`viewport/marks.ts`) and dim opacity. */
const AMBER = "#e8a94a";
const DIM_OPACITY = 0.14;

/** The read-only viewport probe (`AssemblyViewport` publishes it on `window.__rwViewport`). */
interface CompareProbe {
  marks(): Record<string, string>;
  color(id: string): string | null;
  opacity(id: string): number | null;
}
const probe = (page: Page) => ({
  marks: () => page.evaluate(() => (window as unknown as { __rwViewport: CompareProbe }).__rwViewport.marks()),
  color: (id: string) => page.evaluate((i) => (window as unknown as { __rwViewport: CompareProbe }).__rwViewport.color(i), id),
  opacity: (id: string) => page.evaluate((i) => (window as unknown as { __rwViewport: CompareProbe }).__rwViewport.opacity(i), id),
});
const shellStatus = (page: Page) => page.evaluate(() => (window as unknown as { __rwShell?: { status: string } }).__rwShell);

const byId = (page: Page, id: string) => page.getByTestId(id);
const compare = (page: Page) => byId(page, "compare");
const viewport = (page: Page) => compare(page).getByTestId("viewport");

async function openPage(page: Page): Promise<void> {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${WEB}?rpc=${encodeURIComponent(RPC)}&http=${encodeURIComponent(HTTP)}&page=01`);
  await page.waitForFunction(() => {
    const st = (window as unknown as { __rwShell?: { status: string } }).__rwShell?.status;
    return st === "ready" || st === "error";
  });
  expect(await shellStatus(page)).toMatchObject({ status: "ready" });
  await expect(byId(page, "history.step")).toHaveCount(4);
  expect(errors).toEqual([]);
}

/** Waits for the compare scene of `old` → `new` to be loaded and drawn. */
async function compared(page: Page, oldV: string, newV: string): Promise<void> {
  await expect(compare(page)).toHaveAttribute("data-old", oldV);
  await expect(compare(page)).toHaveAttribute("data-new", newV);
  await expect(compare(page)).toHaveAttribute("data-state", "ready");
  // The viewport shows this pair's scene (Old>New hashes), not the previous one.
  const scene = await compare(page).getAttribute("data-scene");
  expect(scene).toMatch(/^[0-9a-f]{64}>[0-9a-f]{64}$/);
  await expect(viewport(page)).toHaveAttribute("data-model-key", scene!);
  await expect(viewport(page)).toHaveAttribute("data-ready", "true");
}

test.beforeAll(() => {
  expect(WEB, "RW_E2E_WEB_URL from global-setup").not.toBe("");
  expect(RPC, "RW_E2E_RPC_URL from global-setup").not.toBe("");
});

test("strip Compare opens the view; steps, marks, metrics with units, legend, Close", async ({ page }) => {
  await openPage(page);
  await byId(page, "history.compare").click();
  await expect(byId(page, "history.compare")).toHaveAttribute("aria-pressed", "true");
  // Default: the step before the latest against the latest. 04 only edits sims and configs.
  await compared(page, "step:3", "step:4");
  await expect(byId(page, "compare.title")).toHaveText("Step 03 → Step 04");
  await expect(viewport(page)).toHaveAttribute("data-glb-source", "rw-wasm");
  await expect(byId(page, "compare.changes")).toHaveCount(0);
  await expect(byId(page, "compare.edits").locator('[data-path="/sims/baseline/launch/rail_length"]')).toContainText("1.5 m → 2 m");
  // The legend and the bar (Backplane: Old / New, Removed / Changed / Added, Close).
  const legend = byId(page, "compare.legend");
  for (const name of ["Removed", "Changed", "Added"]) await expect(legend).toContainText(name);
  await expect(legend.locator(":scope > [data-mark]")).toHaveCount(3);
  await expect(byId(page, "assembly")).toHaveCount(0);

  // Old = Step 02, New = Step 03: the fin revision marks the fins amber, the rest dimmed.
  await byId(page, "compare.old").selectOption("step:2");
  await byId(page, "compare.new").selectOption("step:3");
  await compared(page, "step:2", "step:3");
  await expect(viewport(page)).toHaveAttribute("data-marks", "fins:changed");
  const vp = probe(page);
  expect(await vp.marks()).toEqual({ fins: "changed" });
  expect(await vp.color("fins")).toBe(AMBER);
  expect(await vp.opacity("fins")).toBe(1);
  expect(await vp.opacity("nose")).toBeCloseTo(DIM_OPACITY, 6);
  await expect(viewport(page).locator('[data-testid="vp.leader-label"]')).toHaveCount(1);
  await expect(viewport(page).locator('[data-testid="vp.leader-label"][data-part="fins"]')).toHaveAttribute("data-mark", "changed");
  const fins = byId(page, "compare.changes").locator('[data-part="fins"]');
  await expect(fins).toHaveAttribute("data-mark", "changed");
  await expect(fins.locator('[data-path="/shape/span"]')).toContainText("90 mm → 100 mm");
  const span = byId(page, "compare.metrics").locator('[data-metric="dims.fin_span"]');
  await expect(span).toHaveAttribute("data-tone", "up");
  await expect(span).toContainText(/\d mm/);
  await expect(byId(page, "compare.metrics").locator('[data-metric="stability.liftoff"]')).toContainText("cal");
  await expect(byId(page, "compare.edits").locator('[data-path="/params/fin_span/value"]')).toContainText("90 mm → 100 mm");

  // Swap reverses the direction.
  await byId(page, "compare.swap").click();
  await compared(page, "step:3", "step:2");
  await expect(fins.locator('[data-path="/shape/span"]')).toContainText("100 mm → 90 mm");

  // Step 01 → 02 moved the flight computer only.
  await byId(page, "compare.old").selectOption("step:1");
  await byId(page, "compare.new").selectOption("step:2");
  await compared(page, "step:1", "step:2");
  await expect(viewport(page)).toHaveAttribute("data-marks", "flight_computer:changed");
  await expect(byId(page, "compare.changes").locator('[data-part="flight_computer"] [data-path="/attach/offset"]')).toContainText("20 mm → 25 mm");

  await byId(page, "compare.close").click();
  await expect(compare(page)).toHaveCount(0);
  await expect(byId(page, "assembly")).toBeVisible();
  await expect(byId(page, "history.compare")).toHaveAttribute("aria-pressed", "false");
});

test("runs and revisions in the pickers: two runs show the flight deltas first", async ({ page }) => {
  await openPage(page);
  await byId(page, "history.compare").click();
  await compared(page, "step:3", "step:4");
  const old = byId(page, "compare.old");
  // Rev 07 is step 04: nothing differs.
  await old.selectOption("rev:7");
  await compared(page, "rev:7", "step:4");
  await expect(byId(page, "compare.title")).toHaveText("Rev 07 → Step 04");
  await expect(byId(page, "compare.metrics").locator('tr[data-tone="up"], tr[data-tone="down"]')).toHaveCount(0);
  // Fin revision (flown on step 02) → Baseline (step 04).
  const runs = await old.locator('optgroup[label="Runs"] option').evaluateAll((os) => os.map((o) => [(o as HTMLOptionElement).value, o.textContent ?? ""] as [string, string]));
  const fin = runs.find(([, t]) => t.startsWith("Fin revision"))![0]!;
  const base = runs.find(([, t]) => t.startsWith("Baseline"))![0]!;
  await old.selectOption(fin);
  await byId(page, "compare.new").selectOption(base);
  await compared(page, fin, base);
  await expect(byId(page, "history.run-compare")).toContainText("Fin revision → Baseline");
  await expect(byId(page, "compare.metrics").locator("tbody tr").first()).toHaveAttribute("data-metric", "apogee_m");
  await expect(byId(page, "compare.metrics").locator('[data-metric="apogee_m"]')).toContainText(" m");
  await expect(viewport(page)).toHaveAttribute("data-marks", "fins:changed");
});

test("Revert from the strip menu and the Compare bar restores a step as a new step", async ({ page }) => {
  await openPage(page);
  // Strip: select Step 03, ⋯ → Revert to Step 03.
  await byId(page, "history.step").nth(2).click();
  await byId(page, "history.menu").click();
  await expect(byId(page, "history.revert")).toHaveText("Revert to Step 03");
  await byId(page, "history.revert").click();
  await expect(byId(page, "history.step")).toHaveCount(5);
  await expect(byId(page, "history.step").last()).toHaveAttribute("title", "Restored Step 03");
  // The Compare bar: Old = Step 04 → Revert restores it; the project ends as it began (model of step 04).
  await byId(page, "history.compare").click();
  await expect(compare(page)).toHaveAttribute("data-state", "ready");
  await byId(page, "compare.old").selectOption("step:4");
  await byId(page, "compare.new").selectOption("step:5");
  await compared(page, "step:4", "step:5");
  await expect(byId(page, "compare.revert")).toHaveText("Revert to Step 04");
  await byId(page, "compare.revert").click();
  await expect(compare(page)).toHaveCount(0);
  await expect(byId(page, "history.step")).toHaveCount(6);
  await expect(byId(page, "history.step").last()).toHaveAttribute("title", "Restored Step 04");
  // Step 06 equals step 04: nothing differs.
  await byId(page, "history.compare").click();
  await byId(page, "compare.old").selectOption("step:4");
  await byId(page, "compare.new").selectOption("step:6");
  await compared(page, "step:4", "step:6");
  await expect(byId(page, "compare.changes")).toHaveCount(0);
  await expect(byId(page, "compare.edits")).toHaveCount(0);
});
