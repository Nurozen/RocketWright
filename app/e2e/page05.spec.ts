/**
 * M4.7 page 05 (Propulsion > Liquid propulsion design), live: the web bundle
 * on the app server and sidecar over the seeded research vehicle (global
 * setup), whose `engines/` hold the complete demo engine and its incomplete
 * copy (D10b: fluid model and the first line's boundary condition unset).
 * The procedural module comes from the evaluated feed graph and
 * `engine_design`; the diagram, 3D view, rail, and inspector share one
 * selection; the `Missing inputs · N` badge counts the check report's
 * RW-W210/W211; Properties shows `engine_design`'s numbers; Source
 * references link the literature.
 */
import { execFileSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";

const WEB = process.env["RW_E2E_WEB_URL"] ?? "";
const RPC = process.env["RW_E2E_RPC_URL"] ?? "";
const HTTP = process.env["RW_E2E_HTTP_URL"] ?? "";
const PROJECT = process.env["RW_E2E_PROJECT"] ?? "";
const BIN = process.env["RW_SIDECAR_BIN"] ?? "";

const viewport = (page: Page) => page.getByTestId("viewport");
const node = (page: Page, id: string) => page.locator(`[data-testid="diagram.node"][data-node="${id}"]`);
const edge = (page: Page, i: number) => page.locator(`[data-testid="diagram.edge"][data-edge="${i}"]`);
/** Clicks a diagram line (its wide hit stroke; the bounding-box centre of an elbow is off the line). */
const clickEdge = (page: Page, i: number) => page.locator(`[data-testid="diagram.edge-hit"][data-edge="${i}"]`).dispatchEvent("click");
const category = (page: Page, id: string) => page.locator(`[data-testid="rail.nav-row"][data-category="${id}"]`);
const input = (page: Page, key: string) => page.locator(`[data-testid="insp.input"][data-key="${key}"]`);
const pageTab = (page: Page, id: string) => page.locator(`[data-testid="propulsion.tab"][data-group="page"][data-tab="${id}"]`);
const inspTab = (page: Page, id: string) => page.locator(`[data-testid="propulsion.tab"][data-group="inspector"][data-tab="${id}"]`);

type ProbeName = "visibleParts" | "pointFor" | "outlined" | "detail";
async function probe<T>(page: Page, name: ProbeName, ...args: unknown[]): Promise<T> {
  return page.evaluate(
    ([n, a]) => {
      const p = (window as unknown as { __rwViewport: Record<string, (...x: unknown[]) => unknown> }).__rwViewport;
      return p[n as string]!(...(a as unknown[]));
    },
    [name, args] as const,
  ) as Promise<T>;
}

/** The sidecar's own `engine_design` for an engine of the live project (the numbers the page must show). */
function engineDesign(engine: string): { performance: Record<string, number>; design: { sizing: Record<string, number>; assumptions: string[] } } {
  return JSON.parse(execFileSync(BIN, ["-C", PROJECT, "--json", "call", "engine_design", JSON.stringify({ engine })], { encoding: "utf8", env: { ...process.env, RW_OFFLINE: "1" } })) as ReturnType<typeof engineDesign>;
}

async function showEngine(page: Page, id: string): Promise<void> {
  await page.getByTestId("liquid.engine").selectOption(id);
  await expect(page.getByTestId("liquid-page")).toHaveAttribute("data-engine", id);
  await expect(viewport(page)).toHaveAttribute("data-model-key", new RegExp(`^${id}@`));
  await expect(viewport(page)).toHaveAttribute("data-ready", "true");
}

test.beforeAll(() => {
  expect(WEB, "RW_E2E_WEB_URL from global-setup").not.toBe("");
  expect(PROJECT, "RW_E2E_PROJECT from global-setup").not.toBe("");
  expect(BIN, "RW_SIDECAR_BIN from global-setup").not.toBe("");
});

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${WEB}?rpc=${encodeURIComponent(RPC)}&http=${encodeURIComponent(HTTP)}&page=05`);
  await page.waitForFunction(() => (window as { __rwShell?: { status: string } }).__rwShell?.status === "ready");
  await expect(page.getByTestId("liquid-page")).toBeVisible();
  await expect(page.getByTestId("liquid-page")).toHaveAttribute("data-engine", "demo", { timeout: 30_000 });
  await expect(viewport(page)).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
  expect(errors).toEqual([]);
});

test("renders the page 05 structure from the engine's feed graph", async ({ page }) => {
  await expect(page.getByTestId("page.title")).toHaveText("Liquid propulsion");
  await expect(page.locator('[data-testid="propulsion.tab"][data-group="page"]')).toHaveText(["Assembly", "System", "Properties"]);
  await expect(pageTab(page, "system")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("rail.nav-title")).toHaveText("Propulsion system");
  await expect(page.locator('[data-testid="rail.nav-row"]')).toHaveText(["Propellant storage", "Feed system", "Valves", "Engine assembly", "Sensors"]);
  await expect(page.getByTestId("tree.eye")).toHaveCount(5);
  // The composer is the embedded Lecturn pane's (B17); its per-page placeholder is unit-tested (`embed/composerHints.test.ts`).
  // The module: every feed node and line is a part, each with visual-only detail.
  const parts = await probe<string[]>(page, "visibleParts");
  for (const id of ["tank_a", "tank_b", "valve_a", "valve_b", "engine", "pt_a", "pt_c", "edge:0", "edge:1", "edge:2", "edge:3", "edge:4", "edge:5"]) expect(parts).toContain(id);
  const detail = await probe<{ id: string; builder: string; meshes: number }[]>(page, "detail");
  expect(detail.find((d) => d.id === "tank_a")?.builder).toBe("liquid-tank");
  expect(detail.find((d) => d.id === "engine")?.builder).toBe("liquid-engine");
  expect(detail.find((d) => d.id === "edge:0")?.builder).toBe("liquid-line");
  expect(detail.find((d) => d.id === "valve_a")?.builder).toBe("liquid-valve");
  // Leader labels Storage, Feed, Engine (their order follows the layout).
  await expect(page.locator('[data-testid="vp.leader-label"]')).toHaveCount(3);
  expect((await page.locator('[data-testid="vp.leader-label"]').allInnerTexts()).sort()).toEqual(["Engine", "Feed", "Storage"]);
  // The connectivity diagram: five nodes, four flow lines (oxidizer teal, fuel amber).
  await expect(page.getByTestId("connectivity-diagram")).toContainText("Connectivity diagram");
  await expect(page.getByTestId("diagram.node")).toHaveText(["Tank A", "Valve A", "Tank B", "Valve B", "Engine"]);
  await expect(node(page, "tank_a")).toHaveAttribute("data-role", "ox");
  await expect(node(page, "tank_b")).toHaveAttribute("data-role", "fuel");
  await expect(page.getByTestId("diagram.edge")).toHaveCount(4);
  for (const [i, role] of [
    [0, "ox"],
    [1, "ox"],
    [2, "fuel"],
    [3, "fuel"],
  ] as const)
    await expect(edge(page, i)).toHaveAttribute("data-role", role);
  // Inspector tabs; nothing selected yet.
  await expect(page.locator('[data-testid="propulsion.tab"][data-group="inspector"]')).toHaveText(["Selected connection", "Inputs", "Assumptions"]);
  await expect(inspTab(page, "connection")).toHaveAttribute("aria-selected", "true");
  // The complete engine has no missing inputs.
  await expect(page.getByTestId("agent.missing-inputs")).toHaveCount(0);
  await expect(input(page, "fluid_model")).toContainText("Single-phase liquid");
});

test("one selection across the diagram, the 3D view, the rail, and the inspector", async ({ page }) => {
  // A diagram line selects its flow path: Tank A → Engine.
  await clickEdge(page, 0);
  await expect(viewport(page)).toHaveAttribute("data-selected", "edge:0,edge:1");
  await expect(edge(page, 0)).toHaveAttribute("data-selected", "true");
  await expect(edge(page, 1)).toHaveAttribute("data-selected", "true");
  await expect(edge(page, 2)).toHaveAttribute("data-selected", "false");
  await expect(node(page, "tank_a")).toHaveAttribute("data-selected", "true");
  await expect(category(page, "feed")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("insp.connection")).toHaveAttribute("data-from", "tank_a");
  await expect(page.getByTestId("insp.connection")).toHaveAttribute("data-to", "engine");
  await expect(page.getByTestId("insp.connection")).toContainText("Tank A");
  await expect(page.getByTestId("insp.connection")).toContainText("Engine");
  await expect(page.locator('[data-testid="vp.leader-label"][data-part="edge:0"]')).toHaveText("Feed");

  // A 3D pick: Tank B selects its node in the diagram and Propellant storage in the rail.
  const pt = await probe<{ x: number; y: number } | null>(page, "pointFor", "tank_b");
  expect(pt, "Tank B is pickable on screen").not.toBeNull();
  await page.mouse.click(pt!.x, pt!.y);
  await expect(viewport(page)).toHaveAttribute("data-selected", "tank_b");
  await expect(node(page, "tank_b")).toHaveAttribute("aria-pressed", "true");
  await expect(category(page, "storage")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("insp.connection")).toHaveAttribute("data-from", "tank_b");
  await expect(edge(page, 2)).toHaveAttribute("data-selected", "true");

  // A rail row selects its first entity.
  await category(page, "valves").click();
  await expect(viewport(page)).toHaveAttribute("data-selected", "valve_a");
  await expect(node(page, "valve_a")).toHaveAttribute("aria-pressed", "true");
  // A diagram node: the engine joins both paths.
  await node(page, "engine").click();
  await expect(viewport(page)).toHaveAttribute("data-selected", "engine");
  await expect(page.getByTestId("insp.connection")).toHaveAttribute("data-from", "tank_a,tank_b");
  await expect(category(page, "engine")).toHaveAttribute("aria-selected", "true");
});

test("with the embedded pane, Missing inputs and Review inputs stay RocketWright rows outside the embed rect (B10, D10)", async ({ page }) => {
  await page.goto(`${WEB}?rpc=${encodeURIComponent(RPC)}&http=${encodeURIComponent(HTTP)}&page=05`);
  await page.waitForFunction(() => (window as { __rwShell?: { status: string } }).__rwShell?.status === "ready");
  await expect(page.getByTestId("liquid-page")).toHaveAttribute("data-engine", "demo", { timeout: 30_000 });
  await expect(viewport(page)).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
  const pane = page.getByTestId("agent-pane");
  await expect(pane).toHaveAttribute("data-embedded", "true");
  await showEngine(page, "demo-incomplete");
  const strip = pane.getByTestId("agent.extras");
  await expect(strip.getByTestId("agent.missing-inputs")).toHaveText(/Missing inputs · 2/);
  await expect(pane.getByTestId("agent.embed").getByTestId("agent.missing-inputs")).toHaveCount(0);
  await strip.getByTestId("agent.review-inputs").click();
  await expect(viewport(page)).toHaveAttribute("data-selected", "edge:0,edge:1");
});

test("the incomplete engine: Missing inputs · 2 from the check, inputs flagged, analysis blocked", async ({ page }) => {
  await showEngine(page, "demo-incomplete");
  const badge = page.getByTestId("agent.missing-inputs");
  await expect(badge).toHaveText(/Missing inputs · 2/);
  await expect(badge).toHaveAttribute("data-count", "2");
  await expect(page.getByTestId("agent.review-inputs")).toHaveText("Review inputs");
  await page.getByTestId("agent.review-inputs").click();
  // Review inputs selects the line with the unset boundary condition (edge 0: Tank A → Valve A).
  await expect(viewport(page)).toHaveAttribute("data-selected", "edge:0,edge:1");
  await expect(input(page, "fluid_model")).toHaveAttribute("data-tone", "warn");
  await expect(input(page, "fluid_model")).toContainText("Not selected");
  await expect(input(page, "boundary_conditions")).toHaveAttribute("data-tone", "warn");
  await expect(input(page, "boundary_conditions")).toContainText("Required");
  await expect(input(page, "analysis")).toContainText("Not run");
  await expect(page.getByTestId("propulsion.analysis")).toHaveAttribute("data-blocked", "true");
  await expect(page.getByTestId("propulsion.run-analysis")).toHaveCount(0);
  await expect(page.getByTestId("propulsion.analysis-blocked")).toContainText("2 missing inputs");
  // The fuel path is complete: its boundary conditions are set.
  await clickEdge(page, 2);
  await expect(input(page, "boundary_conditions")).toHaveAttribute("data-tone", "ok");
  await expect(input(page, "boundary_conditions")).toContainText("Open, Check valve");
  // Inputs tab lists the unset fluid model and line.
  await inspTab(page, "inputs").click();
  await expect(page.locator('[data-testid="insp.inputs"] [data-key="fluid_model"]')).toHaveAttribute("data-warn", "true");
});

test("the complete engine runs its analysis", async ({ page }) => {
  await node(page, "tank_a").click();
  await expect(page.getByTestId("propulsion.analysis")).toHaveAttribute("data-blocked", "false");
  await page.getByTestId("propulsion.run-analysis").click();
  await expect(page.getByTestId("propulsion.analysis")).toHaveAttribute("data-state", "complete", { timeout: 30_000 });
  await expect(input(page, "analysis")).toContainText(/Complete · [\d.]+ s burn/);
});

test("Properties shows engine_design's computed performance and geometry", async ({ page }) => {
  const want = engineDesign("demo");
  await pageTab(page, "properties").click();
  await expect(pageTab(page, "properties")).toHaveAttribute("aria-selected", "true");
  const props = page.getByTestId("liquid.properties");
  await expect(props).toHaveAttribute("data-state", "ready");
  const value = (key: string) => props.locator(`[data-testid="props.row"][data-key="${key}"] dd`);
  const n = async (key: string) => Number((await value(key).innerText()).replace(/[^0-9.]/g, ""));
  expect(await n("isp_sl")).toBeCloseTo(want.performance["isp_sl"]!, 0);
  expect(await n("isp_vac")).toBeCloseTo(want.performance["isp_vac"]!, 0);
  expect(await n("c_star")).toBeCloseTo(want.performance["c_star"]!, -1);
  expect(await n("thrust")).toBeCloseTo(want.performance["thrust"]!, -1);
  expect(await n("mdot")).toBeCloseTo(want.performance["mdot"]!, 2);
  expect(await n("throat_diameter")).toBeCloseTo(want.performance["throat_diameter"]! * 1000, 1);
  expect(await n("exit_diameter")).toBeCloseTo(want.performance["exit_diameter"]! * 1000, 1);
  expect(await n("chamber_length")).toBeCloseTo(want.design.sizing["chamber_length"]! * 1000, 0);
  for (const g of ["performance", "geometry", "injector", "tank:tank_a", "tank:tank_b", "blowdown"]) await expect(props.locator(`[data-testid="props.group"][data-group="${g}"]`)).toHaveCount(1);
  await expect(props.getByTestId("insp.source-link").first()).toHaveAttribute("href", /ntrs\.nasa\.gov/);
});

test("Source references and Assumptions", async ({ page }) => {
  await page.getByTestId("insp.source-references").click();
  const links = page.getByTestId("insp.source-link");
  await expect(links).toHaveCount(3);
  await expect(links.first()).toHaveText(/NASA SP-125/);
  await expect(links.first()).toHaveAttribute("href", "https://ntrs.nasa.gov/citations/19710019929");
  await inspTab(page, "assumptions").click();
  await expect(page.getByTestId("insp.assumptions")).toContainText("Single-phase liquid propellants");
});

test("the rail eye hides a category in the 3D view", async ({ page }) => {
  await category(page, "storage").getByTestId("tree.eye").click();
  await expect(viewport(page)).toHaveAttribute("data-hidden", /tank_a/);
  const parts = await probe<string[]>(page, "visibleParts");
  expect(parts).not.toContain("tank_a");
  expect(parts).not.toContain("tank_b");
  expect(parts).toContain("engine");
  await category(page, "storage").getByTestId("tree.eye").click();
  expect(await probe<string[]>(page, "visibleParts")).toContain("tank_a");
});
