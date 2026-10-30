/**
 * M2.9 page 02 (Design > Components), live: the web bundle on the app server
 * and sidecar over the seeded research vehicle (global setup), no contract
 * JSON. The schema-driven editor shows the fin set's fields from the model;
 * the shaded orthographic profile carries CG/CP markers and dimensions equal
 * to `rw check --json`; the seeded fin revision (step 03) shows as the
 * proposal over the amber ghost of step 02 with a Changed fields card;
 * a field edit previews live (rw-wasm), validates against the param limits,
 * commits a history step, and Revert change steps back; Escape discards.
 * Tabs are remembered per part; a mixed selection edits only Appearance.
 * A vented freeform fixture (REV2-web): the freeform outline editor adds,
 * moves, and removes points, refuses a self-crossing outline (RW-E061), and
 * the part preview and profile draw the outline; cut vents are subtracted
 * from the tube in the shaded views (R2.4, R6.4).
 */
import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { auxProject, REPO, type AuxProject } from "./aux-project.ts";

const WEB = process.env["RW_E2E_WEB_URL"] ?? "";
const RPC = process.env["RW_E2E_RPC_URL"] ?? "";
const HTTP = process.env["RW_E2E_HTTP_URL"] ?? "";
const PROJECT = process.env["RW_E2E_PROJECT"] ?? "";

interface CheckJson {
  mass: { cg: number };
  aero: { cp: number };
  dims: { length: number };
  stability: { liftoff: number };
}

function rwCheck(): CheckJson {
  const bin = process.env["RW_SIDECAR_BIN"] || "rocketwright";
  try {
    return JSON.parse(execFileSync(bin, ["-C", PROJECT, "--json", "check"], { encoding: "utf8" })) as CheckJson;
  } catch (e) {
    const out = (e as { stdout?: string }).stdout;
    if (out) return JSON.parse(out) as CheckJson;
    throw e;
  }
}

/** `params.fin_span.value` as written in the project's rocket file. */
const finSpanSource = () => /\[params\.fin_span\][^[]*?value = "([^"]+)"/s.exec(readFileSync(join(PROJECT, "rocket.rw.toml"), "utf8"))?.[1];

const field = (page: Page, key: string) => page.locator(`[data-testid="editor.field"][data-field="${key}"]`);
const input = (page: Page, key: string) => field(page, key).locator("input");
const row = (page: Page, id: string) => page.locator(`[data-testid="rail.nav-row"][data-part="${id}"]`);
const tab = (page: Page, name: string) => page.getByTestId("editor.tab").filter({ hasText: name });
const steps = (page: Page) => page.getByTestId("history.step");

test.beforeAll(() => {
  expect(WEB, "RW_E2E_WEB_URL from global-setup").not.toBe("");
  expect(PROJECT, "RW_E2E_PROJECT from global-setup").not.toBe("");
});

/** Specs on their own project (aux-project.ts) open it themselves. */
const FREEFORM = "vented freeform fixture";

test.beforeEach(async ({ page }, info) => {
  if (info.titlePath.includes(FREEFORM)) return;
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${WEB}?rpc=${encodeURIComponent(RPC)}&http=${encodeURIComponent(HTTP)}&page=02`);
  await page.waitForFunction(() => (window as { __rwShell?: { status: string } }).__rwShell?.status === "ready");
  await expect(page.getByTestId("components-page")).toBeVisible();
  await expect(page.getByTestId("viewport")).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
  // The page opens on the fin set (concept 02) and finds its proposal.
  await expect(page.getByTestId("editor")).toHaveAttribute("data-part", "fins");
  await expect(page.getByTestId("viewport")).toHaveAttribute("data-ghost", "true", { timeout: 30_000 });
  expect(errors).toEqual([]);
});

test("with the embedded pane, Changed fields renders in the RocketWright strip outside the embed rect (B10, D10)", async ({ page }) => {
  await page.goto(`${WEB}?rpc=${encodeURIComponent(RPC)}&http=${encodeURIComponent(HTTP)}&page=02`);
  await page.waitForFunction(() => (window as { __rwShell?: { status: string } }).__rwShell?.status === "ready");
  const pane = page.getByTestId("agent-pane");
  await expect(pane).toHaveAttribute("data-embedded", "true");
  const strip = pane.getByTestId("agent.extras");
  const rect = pane.getByTestId("agent.embed");
  await expect(strip.getByTestId("agent.changed-fields")).toContainText("Span90 → 100 mm", { timeout: 30_000 });
  await expect(rect).toBeVisible();
  await expect(rect.getByTestId("agent.changed-fields")).toHaveCount(0);
  await expect(pane.getByTestId("agent.composer")).toHaveCount(0);
  const s = (await strip.boundingBox())!;
  const r = (await rect.boundingBox())!;
  expect(s.y + s.height).toBeLessThanOrEqual(r.y + 1);
  await strip.getByTestId("agent.compare-revisions").click();
  await expect(page.getByTestId("compare.title")).toHaveText("Step 02 → Step 03");
});

test("renders the fin set editor, profile, markers, and proposal from the model", async ({ page }) => {
  // Schema-driven fields with units and the model's values (seeded: span 100, sweep 40 via params).
  await expect(page.getByTestId("editor.tab")).toHaveText(["Geometry", "Material", "Appearance", "Mass override"]);
  await expect(tab(page, "Geometry")).toHaveAttribute("aria-selected", "true");
  const want: Record<string, string> = { root_chord: "140", tip_chord: "60", span: "100", sweep: "40", thickness: "3", count: "4" };
  for (const [k, v] of Object.entries(want)) await expect(input(page, k)).toHaveValue(v);
  await expect(field(page, "span")).toContainText("mm");
  // Labels never show source paths; the shared parameter is explained in words in the tooltip.
  await expect(page.getByTestId("editor")).not.toContainText("params.");
  await expect(field(page, "span")).toHaveAttribute("title", /^Shared value “fin span”/);
  await expect(field(page, "count")).toContainText("Fin count");

  // CG/CP and dimensions are `rw check --json`'s; CG forward of CP.
  const check = rwCheck();
  const cg = page.getByTestId("vp.cg");
  const cp = page.getByTestId("vp.cp");
  await expect(cg).toHaveAttribute("data-station", check.mass.cg.toFixed(4));
  await expect(cp).toHaveAttribute("data-station", check.aero.cp.toFixed(4));
  expect(Number(await cg.getAttribute("data-x"))).toBeLessThan(Number(await cp.getAttribute("data-x")));
  await expect(cg).toContainText(`${Math.round(check.mass.cg * 1000)} mm`);
  await expect(page.locator('[data-testid="vp.dimension"][data-dim="overall"]')).toHaveAttribute("data-value", check.dims.length.toFixed(4));
  await expect(page.locator('[data-testid="vp.dimension"][data-dim="cg-cp"]')).toHaveAttribute("data-value", (check.aero.cp - check.mass.cg).toFixed(4));
  await expect(page.getByTestId("vp.stability")).toHaveText(`Stability ${check.stability.liftoff.toFixed(2)} cal`);
  await expect(page.getByTestId("vp.view-label")).toHaveText("Side view (X-Z)");
  await expect(page.getByTestId("vp.scale")).toHaveText(/^Scale: 1:\d/);
  await expect(page.getByTestId("vp.axis-gizmo")).toHaveAttribute("data-view", "side");
  await expect(page.getByTestId("vp.grid")).toHaveCount(1);

  // Proposal (step 03) over the ghost of step 02; every fin of the set filled alike.
  await expect(page.getByTestId("vp.proposal")).toHaveAttribute("data-fins", "4");
  await expect(page.getByTestId("vp.fin")).toHaveCount(4);
  await expect(page.getByTestId("vp.proposal-label")).toContainText("New fin(span 100 mm)");
  await expect(page.getByTestId("vp.ghost-label")).toContainText("Previous fin(span 90 mm)");
  await expect(page.getByTestId("editor.status")).toHaveAttribute("data-kind", "modified");
  await expect(page.getByTestId("editor.status")).toHaveText("Modified · Simulation needs rerun");
  await expect(page.getByTestId("editor.status")).toHaveAttribute("title", /step 03 · Fin revision/);

  // Changed fields from the revision diff, and Compare revisions opens the Compare for those steps.
  const card = page.getByTestId("agent.changed-fields");
  await expect(card).toContainText("Span90 → 100 mm");
  await expect(card).toContainText("Sweep45 → 40 mm");
  // One revision on show (BC5): the strip's current step is the proposal's step 03, the step the
  // Changed fields card diffs to and the thread's history marks current; the head stays step 04.
  const currentStep = page.locator('[data-testid="history.step"][aria-current="step"]');
  await expect(currentStep).toHaveAttribute("data-ref", "rw:step/3");
  await expect(card).toHaveAttribute("data-step", "3");
  // The open thread's own history (when it made or linked steps) marks the same step current.
  const threadCurrent = page.locator('[data-testid="agent.thread-history"] li[data-current="true"]');
  if ((await page.getByTestId("agent.thread-history").count()) > 0) await expect(threadCurrent).toHaveAttribute("data-seq", "3");
  await expect(steps(page).last()).toHaveAttribute("data-head", "true");
  await page.getByTestId("agent.compare-revisions").click();
  await expect(page.getByTestId("compare.title")).toHaveText("Step 02 → Step 03");
  await page.getByTestId("compare.close").click();

  // The live fin profile is dimensioned from the fields.
  const profile = page.getByTestId("editor.profile");
  await expect(profile).toHaveAttribute("data-kind", "fin");
  await expect(profile.getByTestId("editor.profile-root")).toContainText("140 mm");
  await expect(profile.getByTestId("editor.profile-tip")).toContainText("60 mm");
  await expect(profile.getByTestId("editor.profile-span")).toContainText("100 mm");

  // The side view: seams between opaque airframe sections, and the GLB carries the 3D viewport's detail.
  await expect(page.getByTestId("vp.joints")).toHaveAttribute("data-count", /^[1-9]/);

  // Rail footer view chips, all inside the rail (none clipped by its divider).
  await expect(page.getByTestId("rail.view-chip")).toHaveText(["Side", "Top", "Front", "Rear"]);
  const rail = (await page.locator('[data-rw-region="left-rail"]').boundingBox())!;
  for (const chip of await page.getByTestId("rail.view-chip").all()) {
    const b = (await chip.boundingBox())!;
    expect(b.x + b.width).toBeLessThanOrEqual(rail.x + rail.width - 1);
    expect(await chip.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  }

  // History step names and meta never truncate.
  for (const t of await page.locator(".rw-step__name, .rw-step__date").all()) {
    expect(await t.evaluate((el) => el.scrollWidth <= el.clientWidth + 1 && getComputedStyle(el).textOverflow !== "ellipsis")).toBe(true);
  }

  await page.locator('[data-testid="rail.view-chip"][data-view="top"]').click();
  await expect(page.getByTestId("viewport")).toHaveAttribute("data-view", "top");
  await expect(page.getByTestId("vp.view-label")).toHaveText("Top view (X-Y)");
  await page.locator('[data-testid="rail.view-chip"][data-view="front"]').click();
  await expect(page.getByTestId("vp.view-label")).toHaveText("Front view (Y-Z)");
  await expect(page.getByTestId("vp.cg")).toHaveCount(0);
  await page.locator('[data-testid="rail.view-chip"][data-view="side"]').click();
  await expect(page.getByTestId("vp.cg")).toHaveCount(1);
});

test("a field edit previews live, validates limits, commits, and reverts", async ({ page }) => {
  const before = rwCheck();
  const cpBefore = await page.getByTestId("vp.cp").getAttribute("data-station");
  const stepsBefore = await steps(page).count();
  const span = input(page, "span");

  // Out of the param's range (60..120 mm): a validation message, no draft.
  await span.fill("130");
  await expect(page.getByTestId("editor.validation")).toContainText("Span must be at most 120 mm.");
  await expect(field(page, "span")).toHaveAttribute("data-invalid", "true");
  await expect(page.getByTestId("header.save-state")).not.toContainText("Modified");

  // In range: the draft previews everywhere (rw-wasm) before anything is written.
  await span.fill("110");
  await expect(page.getByTestId("editor.validation")).toHaveCount(0);
  await expect(page.getByTestId("vp.proposal-label")).toContainText("(span 110 mm)");
  await expect(page.getByTestId("editor.profile").getByTestId("editor.profile-span")).toContainText("110 mm");
  await expect(page.getByTestId("editor.status")).toHaveAttribute("data-kind", "unsaved");
  await expect(page.getByTestId("agent.changed-fields")).toContainText("Span100 → 110 mm");
  await expect.poll(async () => page.getByTestId("vp.cp").getAttribute("data-station")).not.toBe(cpBefore);
  expect(finSpanSource()).toBe("100 mm");

  // Enter commits one history step through model.patch; the param holds the new value.
  await span.press("Enter");
  await expect(steps(page)).toHaveCount(stepsBefore + 1);
  await expect(page.getByTestId("editor.status")).toHaveAttribute("data-kind", "modified");
  await expect.poll(finSpanSource).toBe("110 mm");
  await expect(page.getByTestId("agent.changed-fields")).toContainText("Span100 → 110 mm");
  expect(rwCheck().aero.cp).not.toBeCloseTo(before.aero.cp, 6);

  // Revert change steps the part back (another step; the model equals the one before).
  await page.getByTestId("editor.revert").click();
  await expect(steps(page)).toHaveCount(stepsBefore + 2);
  await expect.poll(finSpanSource).toBe("100 mm");
  await expect(span).toHaveValue("100");
  await expect.poll(() => rwCheck().aero.cp).toBeCloseTo(before.aero.cp, 9);

  // Escape discards an edit without writing.
  await span.fill("105");
  await expect(page.getByTestId("editor.status")).toHaveAttribute("data-kind", "unsaved");
  await span.press("Escape");
  await expect(span).toHaveValue("100");
  await expect(page.getByTestId("header.save-state")).not.toContainText("Modified");
  await expect(steps(page)).toHaveCount(stepsBefore + 2);
  expect(finSpanSource()).toBe("100 mm");
});

test("tabs are remembered per part; a mixed selection edits only Appearance", async ({ page }) => {
  await tab(page, "Mass override").click();
  await expect(field(page, "override.mass")).toBeVisible();
  await expect(input(page, "override.mass")).toHaveAttribute("placeholder", "Derived");
  await expect(field(page, "override.cg")).toContainText("mm");
  await tab(page, "Material").click();
  await expect(field(page, "material").locator("select")).toHaveValue("balsa");

  await row(page, "nose").click();
  await expect(page.getByTestId("editor")).toHaveAttribute("data-part", "nose");
  await expect(tab(page, "Geometry")).toHaveAttribute("aria-selected", "true");
  await expect(input(page, "length")).toHaveValue("150");
  await expect(page.getByTestId("editor.profile")).toHaveAttribute("data-kind", "part");
  await row(page, "fins").click();
  await expect(tab(page, "Material")).toHaveAttribute("aria-selected", "true");

  // Mixed kinds: Appearance only. Same kind: the shared fields.
  await row(page, "nose").click();
  await row(page, "airframe").click({ modifiers: ["ControlOrMeta"] });
  await expect(page.getByTestId("editor")).toHaveAttribute("data-part", "nose,airframe");
  await expect(page.getByTestId("editor.tab")).toHaveText(["Appearance"]);
  await expect(page.getByTestId("editor.title")).toHaveText("2 parts");
  await row(page, "nose").click({ modifiers: ["ControlOrMeta"] });
  await row(page, "recovery_bay").click({ modifiers: ["ControlOrMeta"] });
  await expect(page.getByTestId("editor")).toHaveAttribute("data-part", "airframe,recovery_bay");
  await expect(page.getByTestId("editor.tab")).toHaveCount(4);
  await expect(field(page, "od")).toBeVisible();
  await expect(input(page, "od")).toHaveValue("54");
});

test("a mass override replaces the derived mass and reverts", async ({ page }) => {
  const before = rwCheck();
  const rocketFile = () => readFileSync(join(PROJECT, "parts", "fin_can.rw.toml"), "utf8");
  expect(rocketFile()).not.toMatch(/override/);
  await tab(page, "Mass override").click();
  const mass = input(page, "override.mass");
  await mass.fill("60");
  await mass.press("Enter");
  await expect.poll(rocketFile).toMatch(/override = \{ mass = "60 g"/);
  await expect(mass).toHaveValue("60");
  await expect.poll(() => rwCheck().mass.cg).not.toBeCloseTo(before.mass.cg, 6);
  await expect(page.getByTestId("agent.changed-fields")).toContainText("Mass— → 60 g");
  await page.getByTestId("editor.revert").click();
  await expect.poll(rocketFile).not.toMatch(/override/);
  await expect.poll(() => rwCheck().mass.cg).toBeCloseTo(before.mass.cg, 9);
});

test("Parts library lists presets from the library (or says there are none)", async ({ page }) => {
  await page.getByTestId("editor.parts-library").click();
  const lib = page.getByTestId("editor.library");
  await expect(lib).toHaveAttribute("data-state", /ready|error/);
  await expect(lib).toHaveAttribute("data-state", "ready");
  const items = await page.getByTestId("editor.library-item").count();
  if (items === 0) await expect(page.getByTestId("editor.library-empty")).toContainText("openrocket-database");
  else await expect(page.getByTestId("editor.library-item").first()).toContainText(/openrocket-database|Apache/);
});

test("undo and redo move through the history with history_restore (buttons and shortcuts)", async ({ page }) => {
  const undo = page.getByTestId("header.undo");
  const redo = page.getByTestId("header.redo");
  const current = page.locator('[data-testid="history.step"][aria-current="step"]');
  await expect(page.getByTestId("header.undo-redo")).toBeVisible();
  await expect(redo).toBeDisabled();
  await expect(redo).toHaveAttribute("title", "Nothing to redo");
  await expect(undo).toBeEnabled();
  await expect(undo).toHaveAttribute("title", /^Undo: back to Step \d\d · .+ \((⌘Z|Ctrl\+Z)\)$/);

  const n = await steps(page).count();
  const start = await steps(page).last().getAttribute("data-ref");
  // The pointer starts on the step the fin proposal shows (the Changed fields card's step); undo/redo move from the head.
  const shown = await page.getByTestId("agent.changed-fields").getAttribute("data-step");
  await expect(current).toHaveAttribute("data-ref", `rw:step/${shown}`);

  // An edit is a step; the pointer follows it.
  const span = input(page, "span");
  await span.fill("105");
  await span.press("Enter");
  await expect(steps(page)).toHaveCount(n + 1);
  await expect.poll(finSpanSource).toBe("105 mm");
  const edit = await steps(page).last().getAttribute("data-ref");
  await expect(current).toHaveAttribute("data-ref", edit!);
  await expect(undo).toHaveAttribute("data-target", start!.replace("rw:step/", "step:"));

  // Undo: a restore of the step before (a new step), the model back, the pointer on that step, redo armed.
  await undo.click();
  await expect(steps(page)).toHaveCount(n + 2);
  await expect.poll(finSpanSource).toBe("100 mm");
  await expect(current).toHaveAttribute("data-ref", start!);
  await expect(steps(page).last()).toContainText("Restored Step");
  await expect(redo).toBeEnabled();
  await expect(redo).toHaveAttribute("data-target", edit!.replace("rw:step/", "step:"));
  await expect(redo).toHaveAttribute("title", /^Redo: forward to Step \d\d · /);

  // Redo and undo from the keyboard (outside text fields).
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("ControlOrMeta+Shift+Z");
  await expect(steps(page)).toHaveCount(n + 3);
  await expect.poll(finSpanSource).toBe("105 mm");
  await expect(current).toHaveAttribute("data-ref", edit!);
  await expect(redo).toBeDisabled();
  await page.keyboard.press("ControlOrMeta+Z");
  await expect(steps(page)).toHaveCount(n + 4);
  await expect.poll(finSpanSource).toBe("100 mm");
  await expect(current).toHaveAttribute("data-ref", start!);

  // Inside a text field the shortcut is the field's own undo: no history step.
  await span.focus();
  await page.keyboard.press("ControlOrMeta+Z");
  await page.waitForTimeout(500);
  await expect(steps(page)).toHaveCount(n + 4);
});

test.describe(FREEFORM, () => {
  let aux: AuxProject;
  const rocket = () => readFileSync(join(aux.dir, "rocket.rw.toml"), "utf8");
  /** The freeform fin outline as written: `[[x, y], …]` in mm. */
  const outline = (): number[][] => {
    const m = /\[c\.fins\][^[]*?points = (\[\[.*?\]\])/s.exec(rocket());
    if (m === null) return [];
    return (JSON.parse(m[1]!) as string[][]).map((p) => p.map((v) => parseFloat(v)));
  };
  const point = (page: Page, i: number) => page.locator(`[data-testid="outline.point"][data-index="${i}"]`);
  const coord = (page: Page, axis: "x" | "y", i: number) => page.locator(`[data-testid="outline.row"][data-index="${i}"] [data-testid="outline.${axis}"]`);

  test.beforeAll(async () => {
    aux = await auxProject(join(REPO, "app/e2e/fixtures/vented-freeform"), "Vented freeform");
  });
  test.afterAll(async () => {
    await aux?.stop();
  });

  test.beforeEach(async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`${WEB}?rpc=${encodeURIComponent(aux.rpc)}&http=${encodeURIComponent(aux.http)}&page=02`);
    await page.waitForFunction(() => (window as { __rwShell?: { status: string } }).__rwShell?.status === "ready");
    await expect(page.getByTestId("viewport")).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
    await expect(page.getByTestId("editor")).toHaveAttribute("data-part", "fins");
    expect(errors).toEqual([]);
  });

  test("the freeform outline editor adds, moves, and removes points (RW-E061)", async ({ page }) => {
    const ed = page.getByTestId("outline");
    await expect(ed).toHaveAttribute("data-points", "4");
    await expect(page.getByTestId("outline.point")).toHaveCount(4);
    await expect(point(page, 0)).toHaveAttribute("data-root", "true");
    await expect(point(page, 3)).toHaveAttribute("data-root", "true");
    // Root ends stay on the root; the outline has 3 edges to add on (the 4th is the root).
    await expect(coord(page, "y", 0)).toBeDisabled();
    await expect(page.getByTestId("outline.add")).toHaveCount(3);
    await expect(coord(page, "x", 1)).toHaveValue("40");
    await expect(coord(page, "y", 1)).toHaveValue("45");
    // The part preview and the profile draw the outline (not a zero-span ellipse).
    await expect(page.getByTestId("editor.profile")).toHaveAttribute("data-kind", "fin");
    const preview = page.getByTestId("editor.profile-outline");
    await expect(preview).toHaveAttribute("data-points", "4");
    await expect(preview).toHaveAttribute("data-span", "0.0450");
    await expect(preview).toHaveAttribute("data-root", "0.0800");
    await expect(page.getByTestId("editor.profile-span")).toContainText("45 mm");
    await expect(page.getByTestId("vp.proposal")).toHaveAttribute("data-fins", "3");
    const facing = page.locator('[data-testid="vp.fin"][data-facing="true"]').first();
    const box = await facing.boundingBox();
    expect(box!.height).toBeGreaterThan(20);

    // Add a point on the tip edge: written as a history step.
    await page.locator('[data-testid="outline.add"][data-edge="1"]').dispatchEvent("pointerdown");
    await expect(ed).toHaveAttribute("data-points", "5");
    await expect.poll(outline).toEqual([
      [0, 0],
      [40, 45],
      [55, 45],
      [70, 45],
      [80, 0],
    ]);
    await expect(preview).toHaveAttribute("data-points", "5");
    // Type a coordinate (display units).
    await coord(page, "y", 2).fill("55");
    await coord(page, "y", 2).press("Enter");
    await expect.poll(() => outline()[2]).toEqual([55, 55]);
    await expect(preview).toHaveAttribute("data-span", "0.0550");

    // A crossing outline: drawn in the error colour, RW-E061 from the model, never saved.
    await coord(page, "x", 1).fill("90");
    await coord(page, "x", 1).press("Enter");
    await expect(ed).toHaveAttribute("data-invalid", "true");
    const v = page.getByTestId("outline.validation");
    await expect(v).toContainText("crosses itself");
    await expect(v.locator('[data-code="RW-E061"]').first()).toContainText("crosses itself");
    await expect(page.getByTestId("outline.bad-edge")).toHaveCount(2);
    expect(outline()[1]).toEqual([40, 45]);
    // Escape discards it.
    await coord(page, "x", 1).focus();
    await coord(page, "x", 1).press("Escape");
    await expect(ed).not.toHaveAttribute("data-invalid", "true");
    await expect(coord(page, "x", 1)).toHaveValue("40");
    await expect(page.getByTestId("outline.validation")).toHaveCount(0);

    // Drag a corner: the release commits the moved point.
    const handle = await point(page, 3).boundingBox();
    const cx = handle!.x + handle!.width / 2;
    const cy = handle!.y + handle!.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx, cy - 10, { steps: 4 });
    await page.mouse.move(cx, cy - 20, { steps: 4 });
    await page.mouse.up();
    await expect.poll(() => outline()[3]![1]).toBeGreaterThan(48);
    // Straight up (the snap is 0.5 mm; a pixel of pointer jitter is allowed).
    expect(Math.abs(outline()[3]![0]! - 70)).toBeLessThanOrEqual(1);

    // Remove the added point (the root ends cannot be removed).
    await expect(page.locator('[data-testid="outline.remove"][data-index="0"]')).toBeDisabled();
    await page.locator('[data-testid="outline.remove"][data-index="2"]').click();
    await expect(ed).toHaveAttribute("data-points", "4");
    await expect.poll(() => outline().length).toBe(4);
    expect(outline()[0]).toEqual([0, 0]);
    expect(outline()[3]).toEqual([80, 0]);
  });

  test("cut vents are subtracted from the tube in the shaded views", async ({ page }) => {
    // Four 6 mm x 30 mm slots through the 0.8 mm wall, as the mass model removes them.
    const vp = page.getByTestId("viewport");
    await expect(vp).toHaveAttribute("data-cuts", "1/1", { timeout: 30_000 });
    const removed = Number(await vp.getAttribute("data-cut-removed-mm3"));
    expect(removed).toBeGreaterThan(4 * 30 * 5.2 * 0.8);
    expect(removed).toBeLessThan(4 * 30 * 6 * 0.8);
    await expect(vp).not.toHaveAttribute("data-cut-failed", /./);
    // The 3D assembly view on page 01 cuts them too.
    await page.goto(`${WEB}?rpc=${encodeURIComponent(aux.rpc)}&http=${encodeURIComponent(aux.http)}&page=01`);
    await page.waitForFunction(() => (window as { __rwShell?: { status: string } }).__rwShell?.status === "ready");
    await expect(page.getByTestId("viewport")).toHaveAttribute("data-cuts", "1/1", { timeout: 30_000 });
    await expect(page.getByTestId("viewport")).toHaveAttribute("data-cut-removed-mm3", String(removed));
    // A cutter is never a drawn part (no label, no tree hit in the view).
    await expect(page.locator('[data-testid="vp.leader-label"][data-part="vents"]')).toHaveCount(0);
  });
});
