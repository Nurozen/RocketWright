/**
 * M5.4 page 06 Imported CFD tier (spec R6.15, Acc 9), live: the web bundle on
 * the app server and sidecar over the seeded research vehicle (global setup).
 * The page imports the RW-generated synthetic field in `fixtures/cfd/`
 * through its import form (`cfd.import` -> the sidecar's `cfd_import`), then
 * draws each step's points coloured by a chosen scalar. For every scalar and
 * every step, the legend's range equals that column's min and max in the
 * step's CSV, computed here from the file itself. The record on disk has
 * `provenance = cfd`, and the page's label is bound to it (I13).
 */
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { REPO_ROOT } from "./bar/paths.ts";

const WEB = process.env["RW_E2E_WEB_URL"] ?? "";
const RPC = process.env["RW_E2E_RPC_URL"] ?? "";
const HTTP = process.env["RW_E2E_HTTP_URL"] ?? "";
const PROJECT = process.env["RW_E2E_PROJECT"] ?? "";
const FIXTURE = join(REPO_ROOT, "fixtures", "cfd");
const STEPS = [
  { file: "tank_t0.0.csv", time: 0 },
  { file: "tank_t0.5.csv", time: 0.5 },
  { file: "tank_t1.0.csv", time: 1 },
];
const SCALARS = ["p", "T", "alpha"];

/** Column min/max of one fixture CSV, parsed independently of the app (header row; `#` lines skipped). */
function fileRanges(file: string): { points: number; ranges: Record<string, { min: number; max: number }> } {
  const lines = readFileSync(join(FIXTURE, file), "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"));
  const header = lines[0]!.split(",");
  const ranges: Record<string, { min: number; max: number }> = {};
  for (const h of header) ranges[h] = { min: Infinity, max: -Infinity };
  for (const row of lines.slice(1)) {
    row.split(",").forEach((cell, i) => {
      const v = Number(cell);
      const r = ranges[header[i]!]!;
      r.min = Math.min(r.min, v);
      r.max = Math.max(r.max, v);
    });
  }
  return { points: lines.length - 1, ranges };
}

const cfd = (page: Page) => page.getByTestId("propsim.cfd");

async function importPath(page: Page, path: string): Promise<void> {
  const form = page.getByTestId("cfd.import-form").first();
  await form.getByTestId("cfd.import-path").fill(path);
  await form.getByTestId("cfd.import").click();
}

test.beforeAll(() => {
  expect(WEB, "RW_E2E_WEB_URL from global-setup").not.toBe("");
  expect(PROJECT, "RW_E2E_PROJECT from global-setup").not.toBe("");
});

/**
 * Each wait is bounded and named (B7e): the merge gate once spent the whole
 * 90 s test timeout in this hook with no sign of which wait hung (the shell
 * wait and the tab click had no timeout of their own, and the shell's
 * "error" status was waited past). Not reproduced in 8 runs (alone, after
 * b4a.spec, and with 14 busy loops on 10 cores); a repeat now fails at the
 * stuck step with the shell's state.
 */
test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${WEB}?rpc=${encodeURIComponent(RPC)}&http=${encodeURIComponent(HTTP)}&page=06`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  type Shell = { status: string; error?: string };
  const shell = () => page.evaluate(() => (window as { __rwShell?: Shell }).__rwShell ?? null);
  await page
    .waitForFunction(() => ["ready", "error"].includes((window as { __rwShell?: Shell }).__rwShell?.status ?? ""), null, { timeout: 45_000 })
    .catch(async (e: unknown) => {
      throw new Error(`the shell did not finish loading (window.__rwShell ${JSON.stringify(await shell())}; page errors ${JSON.stringify(errors)}): ${String(e)}`);
    });
  expect(await shell(), "window.__rwShell").toMatchObject({ status: "ready" });
  await page.locator('[data-testid="propsim.tier-tab"][data-tier="cfd"]').click({ timeout: 15_000 });
  await expect(page.getByTestId("propsim-page")).toHaveAttribute("data-tier", "cfd");
  await expect(cfd(page)).toHaveAttribute("data-state", /^(empty|ready)$/, { timeout: 30_000 });
  expect(errors).toEqual([]);
});

test("imports the synthetic field and colours points with the file's scalar range (Acc 9)", async ({ page }) => {
  await importPath(page, FIXTURE);
  await expect(cfd(page)).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
  await expect(cfd(page)).toHaveAttribute("data-dataset", "tank");
  await expect(cfd(page)).toHaveAttribute("data-provenance", "cfd");
  await expect(page.getByTestId("cfd.provenance")).toHaveText(/^Imported CFD result/);
  // Never the engineering tier's plots or label.
  await expect(page.getByTestId("engineering.plot")).toHaveCount(0);

  // The record on disk: runs/cfd.tank/<run>/cfd.json, provenance cfd.
  const runId = (await page.getByTestId("cfd.run-id").innerText()).match(/Run ([0-9a-f]{12})/)?.[1] ?? "";
  expect(runId).toMatch(/^[0-9a-f]{12}$/);
  expect(readdirSync(join(PROJECT, "runs", "cfd.tank"))).toContain(runId);
  const rec = JSON.parse(readFileSync(join(PROJECT, "runs", "cfd.tank", runId, "cfd.json"), "utf8")) as { provenance: string; steps: unknown[] };
  expect(rec.provenance).toBe("cfd");
  expect(rec.steps).toHaveLength(3);

  await expect(page.getByTestId("cfd.scalar").locator("option")).toHaveText(["p (Pa)", "T (K)", "alpha"]);
  const legend = page.getByTestId("cfd.legend");
  for (const [i, s] of STEPS.entries()) {
    const want = fileRanges(s.file);
    await page.getByTestId("cfd.step").fill(String(i));
    await expect(page.getByTestId("cfd.time")).toHaveAttribute("data-time", String(s.time));
    await expect(page.getByTestId("cfd.time")).toContainText(`step ${i + 1} of 3`);
    await expect(legend).toHaveAttribute("data-file", new RegExp(`${s.file.replace(/\./g, "\\.")}$`));
    await expect(page.getByTestId("cfd.canvas")).toHaveAttribute("data-points", String(want.points));
    for (const name of SCALARS) {
      await page.getByTestId("cfd.scalar").selectOption(name);
      await expect(legend).toHaveAttribute("data-scalar", name);
      expect(Number(await legend.getAttribute("data-min")), `${s.file} ${name} min`).toBe(want.ranges[name]!.min);
      expect(Number(await legend.getAttribute("data-max")), `${s.file} ${name} max`).toBe(want.ranges[name]!.max);
      await expect(page.getByTestId("cfd.legend-min")).toBeVisible();
      await expect(page.getByTestId("cfd.legend-max")).toBeVisible();
    }
  }

  // The points are on the canvas (coloured pixels), in each view.
  for (const view of ["side", "top", "end"]) {
    await page.getByTestId("cfd.view").selectOption(view);
    await expect(page.getByTestId("cfd.canvas")).toHaveAttribute("data-view", view);
    const lit = await page.getByTestId("cfd.canvas").evaluate((c: HTMLCanvasElement) => {
      const g = c.getContext("2d")!;
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let k = 3; k < d.length; k += 4) if (d[k]! > 0) n++;
      return n;
    });
    expect(lit, `${view}: coloured pixels`).toBeGreaterThan(2000);
  }
});

test("a malformed CSV is rejected with its line, and the dataset stays", async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), "rw-e2e-cfd-"));
  const bad = join(dir, "bad_t0.csv");
  writeFileSync(bad, "x,y,p\n0,0,1\n");
  await importPath(page, bad);
  await expect(page.getByTestId("cfd.import-error").first()).toContainText("missing required column(s) z");
  await expect(cfd(page)).toHaveAttribute("data-state", /^(empty|ready)$/);
});
