/**
 * M1.50 page 01 (Design > Assembly), live since M1.53b: the web bundle on the
 * app server and sidecar over the seeded research vehicle (global setup;
 * `fixtures/research-vehicle/seed.sh`), no contract JSON. Every toolbar
 * control changes the store state the viewport applies, the eye toggles hide
 * parts, labels do not overlap, and one selection stays in sync across the
 * tree, the viewport (BVH pick on a real canvas click, leader labels, teal
 * outline), and the inspector cards, whose numbers equal `rw check --json`.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { aoProbeFailures, outputProbeFailures, PAGE01_GATES, type AoProbe, type OutputProbe } from "../apps/web/src/viewport/outputProbe.ts";

const WEB = process.env["RW_E2E_WEB_URL"] ?? "";
const RPC = process.env["RW_E2E_RPC_URL"] ?? "";
const HTTP = process.env["RW_E2E_HTTP_URL"] ?? "";
const PROJECT = process.env["RW_E2E_PROJECT"] ?? "";

/** The parts of the seeded research vehicle, in tree order. */
const PARTS = ["nose", "recovery_bay", "chute", "streamer", "airframe", "bulkhead", "lug", "ebay", "flight_computer", "fin_can", "fins", "motor_casing", "ring_upper", "ring_lower"];

interface CheckJson {
  mass: { components: { component: string; mass: number }[] };
  dims: { components: { component: string; length: number; od?: number | null; id?: number | null }[] };
  clearance: { rule: string; a: string; b?: string | null; required: number; dim: string; pass: boolean }[];
}

/** `rw check --json` on the live project (forwarded to its sidecar, the owner). */
function rwCheck(): CheckJson {
  const bin = process.env["RW_SIDECAR_BIN"] || "rocketwright";
  try {
    return JSON.parse(execFileSync(bin, ["-C", PROJECT, "--json", "check"], { encoding: "utf8" })) as CheckJson;
  } catch (e) {
    // Exit 1 on warnings still prints the report.
    const out = (e as { stdout?: string }).stdout;
    if (out) return JSON.parse(out) as CheckJson;
    throw e;
  }
}

const trimNum = (s: string) => (s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s);
const mm = (m: number) => `${trimNum((m * 1000).toFixed(1))} mm`;
const cm = (m: number) => `${trimNum((m * 100).toFixed(2))} cm`;
const inch = (m: number) => `${trimNum((m / 0.0254).toFixed(2))} in`;
const kg = (v: number) => `${trimNum(v < 1 ? Number(v.toPrecision(3)).toString() : v.toFixed(2))} kg`;
const dims = (c: CheckJson, id: string) => c.dims.components.find((d) => d.component === id)!;

type Probe = NonNullable<Window["__rwViewport"]>;
type ProbeFn = { [K in keyof Probe]: Probe[K] extends (...a: infer A) => infer R ? (...a: A) => R : never };

declare global {
  interface Window {
    __rwShell?: { status: string; error?: string };
    __rwViewport?: {
      pickAt(x: number, y: number): string | null;
      pointFor(id: string): { x: number; y: number } | null;
      partOffset(id: string): [number, number, number] | null;
      cameraDir(): [number, number, number];
      visibleParts(): string[];
      opacity(id: string): number | null;
      outlined(): string[];
      shadowsOn(): boolean;
      sectionOn(): boolean;
      backend(): string;
      detail(): { id: string; builder: string; meshes: number; triangles: number }[];
      probeOutput(): Promise<OutputProbe | null>;
      axisIntervals(): { id: string; lo: number; hi: number }[];
      axisGaps(): [number, number, number, number][];
    };
  }
}

/** Calls a viewport probe method in the page. */
async function probe<K extends keyof ProbeFn>(page: Page, name: K, ...args: Parameters<ProbeFn[K]>): Promise<ReturnType<ProbeFn[K]>> {
  return page.evaluate(
    ([n, a]) => {
      const p = window.__rwViewport as unknown as Record<string, (...x: unknown[]) => unknown>;
      return p[n as string]!(...(a as unknown[]));
    },
    [name, args] as const,
  ) as Promise<ReturnType<ProbeFn[K]>>;
}

const viewport = (page: Page) => page.getByTestId("viewport");
const row = (page: Page, id: string) => page.locator(`[data-testid="rail.nav-row"][data-part="${id}"]`);
const label = (page: Page, id: string) => page.locator(`[data-testid="vp.leader-label"][data-part="${id}"]`);
const chip = (page: Page, name: string) => page.getByTestId("toolbar.view-chip").filter({ hasText: name });
const insp = (page: Page, card: string, rowKey: string): Locator => page.getByTestId(card).locator(`[data-row="${rowKey}"] dd`);

async function expectSelected(page: Page, id: string, title: string): Promise<void> {
  await expect(viewport(page)).toHaveAttribute("data-selected", id);
  await expect(row(page, id)).toHaveAttribute("aria-selected", "true");
  await expect(page.locator('[data-testid="rail.nav-row"][aria-selected="true"]')).toHaveCount(1);
  await expect(page.getByTestId("insp.title")).toHaveText(title);
  await expect(page.getByTestId("inspector")).toHaveAttribute("data-part", id);
  await expect(label(page, id)).toHaveAttribute("data-selected", "true");
}

test.beforeAll(() => {
  expect(WEB, "RW_E2E_WEB_URL from global-setup").not.toBe("");
  expect(RPC, "RW_E2E_RPC_URL from global-setup").not.toBe("");
  expect(PROJECT, "RW_E2E_PROJECT from global-setup").not.toBe("");
});

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${WEB}?rpc=${encodeURIComponent(RPC)}&http=${encodeURIComponent(HTTP)}&page=01`);
  await page.waitForFunction(() => window.__rwShell?.status === "ready" || window.__rwShell?.status === "error");
  expect(await page.evaluate(() => window.__rwShell)).toMatchObject({ status: "ready" });
  await expect(viewport(page)).toHaveAttribute("data-ready", "true");
  await expect(page.getByTestId("vp.leader-label").first()).toBeVisible();
  expect(errors).toEqual([]);
});

test("renders the page 01 structure from the model", async ({ page }) => {
  await expect(page.locator('[data-testid="rail.nav-row"]')).toHaveCount(PARTS.length);
  expect(await page.locator('[data-testid="rail.nav-row"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-part")))).toEqual(PARTS);
  await expect(row(page, "recovery_bay")).toContainText("Recovery bay");
  await expect(page.getByTestId("tree.eye")).toHaveCount(PARTS.length);
  await expect(viewport(page)).toHaveAttribute("data-glb-source", "rw-wasm");
  await expect(viewport(page)).toHaveAttribute("data-render", /^(webgpu|webgl|none)$/);
  await expect(page.getByTestId("vp.axis-gizmo").locator("[data-axis]")).toHaveCount(3);
  for (const id of ["toolbar.explode", "toolbar.section", "toolbar.show-internals", "toolbar.shadows", "toolbar.units"]) await expect(page.getByTestId(id)).toBeVisible();
  await expect(page.getByTestId("toolbar.view-chip")).toHaveCount(5);
  await expect(page.getByTestId("insp.title")).toHaveText("Nothing selected");
  expect((await probe(page, "visibleParts")).length).toBe(PARTS.length);
});

test("view chips switch the camera preset", async ({ page }) => {
  const want: Record<string, (d: [number, number, number]) => boolean> = {
    Top: (d) => d[1] > 0.99,
    Side: (d) => d[2] > 0.99,
    Front: (d) => d[0] < -0.99,
    Rear: (d) => d[0] > 0.99,
    // Concept 01: from aft, above, and to the side (the stack recedes toward the nose).
    Iso: (d) => d[0] > 0 && d[1] > 0 && d[2] > 0,
  };
  for (const [name, ok] of Object.entries(want)) {
    await chip(page, name).click();
    await expect(chip(page, name)).toHaveAttribute("aria-checked", "true");
    await expect(viewport(page)).toHaveAttribute("data-view", name.toLowerCase());
    await expect(page.getByTestId("vp.axis-gizmo")).toHaveAttribute("data-view", name.toLowerCase());
    await expect.poll(async () => ok(await probe(page, "cameraDir")), { message: name }).toBe(true);
  }
});

test("explode slider spreads the parts along their explode directions", async ({ page }) => {
  expect(await probe(page, "partOffset", "nose")).toEqual([0, 0, 0]);
  await page.getByTestId("toolbar.explode").fill("60");
  await expect(viewport(page)).toHaveAttribute("data-explode", "0.60");
  await expect.poll(async () => (await probe(page, "partOffset", "nose"))![0]).toBeLessThan(-0.1);
  const motor = (await probe(page, "partOffset", "motor_casing"))!;
  expect(motor[0]).toBeGreaterThan(0.05);
  // Exploded labels include the internal parts, laid out without overlaps.
  await expect(label(page, "chute")).toBeVisible();
  const boxes = await page.getByTestId("vp.leader-label").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON() as DOMRect));
  expect(boxes.length).toBeGreaterThanOrEqual(10);
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]!, b = boxes[j]!;
      const overlap = a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
      expect(overlap, `labels ${i} and ${j} overlap`).toBe(false);
    }
  await page.getByTestId("toolbar.explode").fill("0");
  await expect(viewport(page)).toHaveAttribute("data-explode", "0.00");
  await expect.poll(async () => probe(page, "partOffset", "nose")).toEqual([0, 0, 0]);
});

test("exploded at 0.6 the stack's parts never overlap on screen and the shared axis shows in every gap", async ({ page }) => {
  await page.getByTestId("toolbar.explode").fill("60");
  await expect(viewport(page)).toHaveAttribute("data-explode", "0.60");
  await expect.poll(async () => (await probe(page, "partOffset", "nose"))![0]).toBeLessThan(-0.1);
  const iv = await probe(page, "axisIntervals");
  const order = iv.map((r) => r.id);
  // The front of the stack: nose, recovery bay, airframe tube, electronics bay, fin can (fins included).
  const front = ["nose", "recovery_bay", "airframe", "ebay", "fin_can"];
  expect(order.filter((id) => front.includes(id))).toEqual(front);
  const gaps = await probe(page, "axisGaps");
  const frontGaps: number[] = [];
  for (let i = 1; i < iv.length; i++) {
    const a = iv[i - 1]!, b = iv[i]!;
    const gap = b.lo - a.hi;
    // Front parts: a clear screen gap the dotted axis runs through; the small aft parts at least never touch.
    const isFront = front.includes(a.id) && front.includes(b.id);
    if (isFront) frontGaps.push(gap);
    expect(gap, `${a.id} | ${b.id}: ${JSON.stringify(iv)}`).toBeGreaterThan(isFront ? 6 : 4);
  }
  // Evenly spaced on screen (the explode's screen rule offsets the Iso perspective).
  expect(Math.max(...frontGaps) / Math.min(...frontGaps), JSON.stringify(frontGaps)).toBeLessThan(1.8);
  // One dotted segment per gap (it spans the gap along the axis).
  expect(gaps.length).toBe(iv.length - 1);
  for (const [x1, y1, x2, y2] of gaps) expect(Math.hypot(x2 - x1, y2 - y1)).toBeGreaterThan(10);
  await expect(page.getByTestId("vp.axis-gap")).toHaveCount(iv.length - 1);
});

test("section toggle cuts the model open (live clipping)", async ({ page }) => {
  await chip(page, "Side").click();
  // Assembled, the stowed parachute is inside the bay: nothing on screen picks it.
  expect(await probe(page, "pointFor", "chute")).toBeNull();
  await page.getByTestId("toolbar.section").click();
  await expect(page.getByTestId("toolbar.section")).toHaveAttribute("aria-checked", "true");
  await expect(viewport(page)).toHaveAttribute("data-section", "true");
  expect(await probe(page, "sectionOn")).toBe(true);
  const p = await probe(page, "pointFor", "chute");
  expect(p).not.toBeNull();
  // A real click through the cut selects it.
  await page.mouse.click(p!.x, p!.y);
  await expectSelected(page, "chute", "Parachute (stowed)");
  await page.getByTestId("toolbar.section").click();
  await expect(viewport(page)).toHaveAttribute("data-section", "false");
  expect(await probe(page, "sectionOn")).toBe(false);
});

test("show internals ghosts the airframe; shadows toggle the contact shadow", async ({ page }) => {
  expect(await probe(page, "opacity", "airframe")).toBe(1);
  await page.getByTestId("toolbar.show-internals").check();
  await expect(viewport(page)).toHaveAttribute("data-internals", "true");
  await expect.poll(async () => probe(page, "opacity", "airframe")).toBeLessThan(0.5);
  expect(await probe(page, "opacity", "flight_computer")).toBe(1);
  await expect(label(page, "flight_computer")).toBeVisible();

  await expect(page.getByTestId("toolbar.shadows")).toBeChecked();
  expect(await probe(page, "shadowsOn")).toBe(true);
  await page.getByTestId("toolbar.shadows").uncheck();
  await expect(viewport(page)).toHaveAttribute("data-shadows", "false");
  expect(await probe(page, "shadowsOn")).toBe(false);
});

test("units switch the inspector's lengths", async ({ page }) => {
  const d = dims(rwCheck(), "recovery_bay");
  await row(page, "recovery_bay").click();
  await expect(insp(page, "insp.mass", "length")).toHaveText(mm(d.length));
  await page.getByTestId("toolbar.units").selectOption("in");
  await expect(insp(page, "insp.mass", "length")).toHaveText(inch(d.length));
  await expect(insp(page, "insp.mass", "od")).toHaveText(inch(d.od!));
  await page.getByTestId("toolbar.units").selectOption("cm");
  await expect(insp(page, "insp.mass", "length")).toHaveText(cm(d.length));
});

test("visual detail, contact shadow, and a crisp teal outline on the selection (M3.0, M3.1)", async ({ page }) => {
  // Detail is visual only (I13): builders ran for the bay, chute, and electronics bay; the inspector numbers stay rw check's.
  const built = new Set((await probe(page, "detail")).map((d) => d.builder));
  for (const b of ["clear-bay", "folded-parachute", "electronics-bay", "motor-casing"]) expect(built, b).toContain(b);
  await row(page, "recovery_bay").click();
  await expectSelected(page, "recovery_bay", "Recovery bay");
  await page.getByTestId("toolbar.explode").fill("60");
  await expect(viewport(page)).toHaveAttribute("data-explode", "0.60");
  test.skip((await probe(page, "backend")) !== "webgpu", "output probes need the WebGPU pipeline");
  await expect.poll(async () => probe(page, "outlined")).toEqual(["recovery_bay"]);
  const out = await page.evaluate(async () => (await window.__rwViewport?.probeOutput()) ?? null);
  expect(out, "output probe").not.toBeNull();
  // BC5: a broad, soft contact shadow (spread and softness on the final output), no hard fringe, and the model fills the view.
  expect(outputProbeFailures(out!, true, PAGE01_GATES), JSON.stringify(out)).toEqual([]);
  // The studio light pool sits on the backdrop under the model.
  const pool = page.getByTestId("vp.light-pool");
  await expect(pool).toHaveCount(1);
  const vpBox = (await viewport(page).boundingBox())!;
  const poolBox = (await pool.boundingBox())!;
  expect(poolBox.width).toBeGreaterThan(0.3 * vpBox.width);
  expect(poolBox.x + poolBox.width / 2).toBeGreaterThan(vpBox.x);
  expect(poolBox.x + poolBox.width / 2).toBeLessThan(vpBox.x + vpBox.width);
  // GTAO (M3.1): ambient occlusion shades the creases on the final output.
  const aoOut = await page.evaluate(async () => (await (window.__rwViewport as unknown as { probeAO(): Promise<AoProbe | null> }).probeAO()) ?? null);
  expect(aoProbeFailures(aoOut), JSON.stringify(aoOut)).toEqual([]);
  // Shadows off: no catcher contribution at all.
  await page.getByTestId("toolbar.shadows").uncheck();
  await expect(viewport(page)).toHaveAttribute("data-shadows", "false");
  const off = await page.evaluate(async () => (await window.__rwViewport?.probeOutput()) ?? null);
  expect(off!.shadow.mass).toBe(0);
  await expect(page.getByTestId("vp.light-pool")).toHaveCount(0);
  expect(outputProbeFailures(off!, false)).toEqual([]);
});

test("selection syncs tree <-> viewport <-> inspector", async ({ page }) => {
  // Tree -> viewport + inspector.
  await row(page, "recovery_bay").click();
  await expectSelected(page, "recovery_bay", "Recovery bay");
  await expect(insp(page, "insp.attachment", "upper")).toHaveText("To Nosecone (base)");
  await expect(insp(page, "insp.attachment", "lower")).toHaveText("To Airframe tube (fore)");
  await expect(insp(page, "insp.attachment", "locking")).toHaveText("Twist lock (4×)");
  // The inspector's numbers are `rw check --json`'s (concepts.md §5.6).
  const check = rwCheck();
  const fit = check.clearance.find((r) => (r.a === "recovery_bay" || r.b === "recovery_bay") && r.dim === "length")!;
  await expect(insp(page, "insp.mass", "mass")).toHaveText(kg(check.mass.components.find((m) => m.component === "recovery_bay")!.mass));
  await expect(insp(page, "insp.clearance", "fits")).toHaveText(`${mm(dims(check, "recovery_bay").id!)} (ID)`);
  await expect(insp(page, "insp.clearance", "required")).toHaveText(`≥ ${mm(fit.required)}`);
  if ((await probe(page, "backend")) !== "none") await expect.poll(async () => probe(page, "outlined")).toEqual(["recovery_bay"]);

  // Viewport click (BVH pick) -> tree + inspector.
  await page.getByTestId("toolbar.explode").fill("60");
  await expect.poll(async () => (await probe(page, "pointFor", "nose")) !== null).toBe(true);
  const nose = (await probe(page, "pointFor", "nose"))!;
  await page.mouse.click(nose.x, nose.y);
  await expectSelected(page, "nose", "Nosecone");
  await expect(insp(page, "insp.attachment", "upper")).toHaveText("None (top of stack)");
  if ((await probe(page, "backend")) !== "none") await expect.poll(async () => probe(page, "outlined")).toEqual(["nose"]);

  // Leader label -> tree + inspector.
  await label(page, "airframe").click();
  await expectSelected(page, "airframe", "Airframe tube");

  // Empty space clears the selection everywhere.
  const vp = (await viewport(page).boundingBox())!;
  const empty = { x: vp.x + 30, y: vp.y + vp.height - 30 };
  expect(await probe(page, "pickAt", empty.x, empty.y)).toBeNull();
  await page.mouse.click(empty.x, empty.y);
  await expect(viewport(page)).toHaveAttribute("data-selected", "");
  await expect(page.locator('[data-testid="rail.nav-row"][aria-selected="true"]')).toHaveCount(0);
  await expect(page.getByTestId("insp.title")).toHaveText("Nothing selected");
});

test("eye toggles hide and show parts", async ({ page }) => {
  const eye = row(page, "lug").getByTestId("tree.eye");
  await expect(label(page, "lug")).toHaveCount(1);
  await eye.click();
  await expect(row(page, "lug")).toHaveAttribute("data-hidden", "true");
  await expect(eye).toHaveAttribute("aria-pressed", "false");
  await expect(viewport(page)).toHaveAttribute("data-hidden", "lug");
  expect(await probe(page, "visibleParts")).not.toContain("lug");
  expect(await probe(page, "pointFor", "lug")).toBeNull();
  await expect(label(page, "lug")).toHaveCount(0);
  // The eye does not change the selection.
  await expect(viewport(page)).toHaveAttribute("data-selected", "");
  await eye.click();
  await expect(row(page, "lug")).not.toHaveAttribute("data-hidden", "true");
  expect(await probe(page, "visibleParts")).toContain("lug");
});

test("the selected part's @ shows beside its label (its chip in the pane: mention.spec.ts)", async ({ page }) => {
  await expect(page.getByTestId("vp.mention")).toHaveCount(0);
  await label(page, "airframe").click();
  await expectSelected(page, "airframe", "Airframe tube");
  const at = page.getByTestId("vp.mention");
  await expect(at).toHaveCount(1);
  await expect(at).toHaveAttribute("data-part", "airframe");
  // The @ sits beside its label without overprinting it.
  const a = (await at.boundingBox())!;
  const l = (await label(page, "airframe").boundingBox())!;
  expect(a.x + a.width <= l.x + 0.5 || l.x + l.width <= a.x + 0.5).toBe(true);
});

test("exploded labels never overlap or collide", async ({ page }) => {
  await page.getByTestId("toolbar.explode").fill("60");
  await expect(viewport(page)).toHaveAttribute("data-explode", "0.60");
  await expect(label(page, "flight_computer")).toHaveCount(1);
  const boxes = await page.getByTestId("vp.leader-label").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON() as DOMRect));
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]!, b = boxes[j]!;
      expect(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top, `labels ${i} and ${j} overlap`).toBe(true);
    }
  await expect(page.locator('[data-testid="vp.leader-label"][data-collided="true"]')).toHaveCount(0);
});
