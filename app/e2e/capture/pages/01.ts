/**
 * Bar capture state for page 01 (Design > Assembly, concept 01; spec B1):
 * the seeded live research vehicle (M1.55: history steps 01-04, Rev 07) with
 * the "Assembly review" thread open, Recovery bay selected, explode 0.6, Iso
 * view, and Launch lug hidden from the tree's eye toggle (checklist
 * 01.tree.hidden: the row dims with a crossed eye). The rail lists the
 * concept's three threads.
 *
 * The agent pane is the Lecturn embed (B10): the "Assembly review" thread
 * comes from the 01 bundle and its live state from the
 * `scripted/visual-01.json` scenario (B13, `../embed.ts`; CPW1R3A): the user
 * bubble with its `rw:c/fins` chip, the design check, Baseline and step 04
 * tool rows, one Baseline run card with its chart, the one-row step card
 * naming Flight runs (B7e: back in the live turn, Lecturn pin5 draws no
 * working or held-call row beside the approval), the reply, a pending app
 * approval and the composer's
 * `rw:c/fins` chip, each checked in the guest before the capture (the turn
 * fits the pane: `../pane-budget.ts`).
 *
 * A desktop `--drive` module (`make bar-visual PAGES=01`): everything goes
 * through the `app_*` broker hooks; the waits read the page's own DOM state.
 */
import { aoProbeFailures, outputProbeFailures, PAGE01_GATES, type AoProbe, type OutputProbe } from "../../../apps/web/src/viewport/outputProbe.ts";
import { stageEmbedPane } from "../embed.ts";
import { Hooks, requireEmbed, settle, waitFor, type DriveContext } from "../hooks.ts";

export const STATE = { page: "assembly", select: "rw:c/recovery_bay", explode: 0.6, view: "iso", thread: "Assembly review", hidden: "lug" } as const;

/** The viewport/inspector/chat attributes the waits and the report read (runs in the page). */
function readState(): Record<string, string | null> {
  const vp = document.querySelector<HTMLElement>('[data-testid="viewport"]');
  return {
    ready: vp?.dataset["ready"] ?? null,
    render: vp?.dataset["render"] ?? null,
    glbSource: vp?.dataset["glbSource"] ?? null,
    view: vp?.dataset["view"] ?? null,
    explode: vp?.dataset["explode"] ?? null,
    selected: vp?.dataset["selected"] ?? null,
    inspector: document.querySelector<HTMLElement>('[data-testid="inspector"]')?.dataset["part"] ?? null,
    thread: document.querySelector('[data-testid="agent.title"]')?.textContent?.trim() ?? null,
    threads: Array.from(document.querySelectorAll('[data-testid="rail.thread"]'))
      .map((t) => t.textContent?.trim() ?? "")
      .join(" | "),
    hidden: Array.from(document.querySelectorAll<HTMLElement>('[data-testid="rail.nav-row"][data-hidden="true"]'))
      .map((r) => `${r.dataset["part"] ?? ""} ${r.querySelector('[data-testid="tree.eye"] svg')?.getAttribute("data-icon") ?? ""}`)
      .join(" | "),
    reply: document.querySelector('[data-testid="agent.reply"]')?.textContent?.trim() ?? null,
    steps: Array.from(document.querySelectorAll('[data-testid="history.step"] .rw-step__name')).map((e) => e.textContent?.trim() ?? "").join(" | "),
    stepCards: Array.from(document.querySelectorAll<HTMLElement>('[data-testid="agent.step-card"]'))
      .map((e) => `${e.dataset["ref"] ?? ""} ${e.dataset["bound"] ?? ""} ${e.textContent?.trim() ?? ""}`)
      .join(" | "),
  };
}

export default async function drive(ctx: DriveContext): Promise<Record<string, unknown>> {
  const { page } = ctx;
  const hooks = await Hooks.open(ctx.rpcUrl);
  try {
    await waitFor(page, "the live viewport", () => document.querySelector('[data-testid="viewport"]')?.getAttribute("data-ready") === "true", null, {
      timeoutMs: 90_000,
      diag: readState,
    });
    await hooks.call("app_navigate", { page: STATE.page });
    await requireEmbed(page);
    // B13: the embed's threads are the 01 bundle, its live state the visual-01 scenario (checked in the guest).
    const pane = await stageEmbedPane(ctx, hooks, { page: "01", scenario: "visual-01" });
    const threads = pane["threads"];
    await hooks.call("app_select", { ref: STATE.select });
    await hooks.call("app_set_view", { explode: STATE.explode, view: STATE.view });
    // Hide Launch lug the way a user does: its tree eye toggle.
    await page.evaluate((id) => {
      document.querySelector<HTMLElement>(`[data-testid="rail.nav-row"][data-part="${id}"] [data-testid="tree.eye"]`)?.click();
    }, STATE.hidden);
    await waitFor(
      page,
      "page 01 state (three threads, seeded history, recovery_bay, explode 0.60, iso, Launch lug hidden; the pane was checked in the guest)",
      (want) => {
        const vp = document.querySelector<HTMLElement>('[data-testid="viewport"]');
        return (
          vp?.dataset["selected"] === want.id &&
          vp.dataset["explode"] === want.explode &&
          vp.dataset["view"] === want.view &&
          document.querySelector(`[data-testid="vp.leader-label"][data-part="${want.id}"]`) !== null &&
          document.querySelectorAll('[data-testid="history.step"]').length >= 4 &&
          document.querySelectorAll('[data-testid="rail.thread"]').length === 3 &&
          document.querySelector(`[data-testid="rail.nav-row"][data-part="${want.hidden}"]`)?.getAttribute("data-hidden") === "true"
        );
      },
      { id: "recovery_bay", explode: STATE.explode.toFixed(2), view: STATE.view, hidden: STATE.hidden },
      { diag: readState },
    );
    // M3.6: the part thumbnails (rendered once per model hash, then cached) are in the tree and inspector.
    await waitFor(page, "part thumbnails", () => document.querySelector('[data-testid="thumbs.status"]')?.getAttribute("data-state") === "ready", null, {
      timeoutMs: 90_000,
      diag: readThumbs,
    });
    // The explode tween and the label layout finish over a few frames.
    await settle(page, 800);
    const thumbs = await page.evaluate(readThumbs, null);
    const thumbFailures = thumbnailFailures(thumbs);
    if (thumbFailures.length > 0) throw new Error(`page 01 thumbnails failed:\n  ${thumbFailures.join("\n  ")}\n${JSON.stringify(thumbs)}`);
    // M3.0/M3.1 viewport probes on the final output: detail builders ran, the contact shadow sits
    // under the model, broad and soft, over a light pool; the model fills the view; and the
    // selection outline is a crisp teal line (outputProbe.ts gates, PAGE01_GATES).
    const viewport = await page.evaluate(async () => {
      const api = window.__rwViewport;
      const ao = (await (api as unknown as { probeAO?(): Promise<AoProbe | null> } | undefined)?.probeAO?.()) ?? null;
      const pool = document.querySelector('[data-testid="vp.light-pool"]')?.getBoundingClientRect() ?? null;
      return { detail: api?.detail() ?? [], output: (await api?.probeOutput()) ?? null, ao, backend: api?.backend() ?? null, pool: pool ? { w: pool.width, h: pool.height } : null };
    }, null);
    const failures = viewportFailures(viewport);
    if (failures.length > 0) throw new Error(`page 01 viewport probes failed:\n  ${failures.join("\n  ")}\n${JSON.stringify(viewport)}`);
    return { state: STATE, threads, dom: await page.evaluate(readState, null), viewport, thumbs, pane };
  } finally {
    hooks.close();
  }
}

/** Detail builders page 01 must show (concept 01's recovery bay, electronics bay, chute). */
const REQUIRED_DETAIL = ["clear-bay", "folded-parachute", "electronics-bay", "bevelled-fins", "nose-shoulder", "airframe-tube", "motor-casing"];

function viewportFailures(v: { detail: { builder: string }[]; output: OutputProbe | null; ao: AoProbe | null; backend: string | null; pool: { w: number; h: number } | null }): string[] {
  const f: string[] = [];
  const built = new Set(v.detail.map((d) => d.builder));
  for (const b of REQUIRED_DETAIL) if (!built.has(b)) f.push(`detail: builder ${b} did not run`);
  if (v.backend !== "webgpu") f.push(`backend ${v.backend} (want webgpu)`);
  if (v.output === null) f.push("no output probe (no render pipeline)");
  else f.push(...outputProbeFailures(v.output, true, PAGE01_GATES));
  f.push(...aoProbeFailures(v.ao));
  if (v.pool === null || v.pool.w < 100) f.push(`pool: no studio light pool under the model (${JSON.stringify(v.pool)})`);
  return f;
}

/** M3.6 regions: which thumbnails show a render (not the placeholder line icon). Runs in the page. */
function readThumbs(): { state: string | null; rows: number; tree: number; inspector: string | null } {
  return {
    state: document.querySelector('[data-testid="thumbs.status"]')?.getAttribute("data-state") ?? null,
    rows: document.querySelectorAll('[data-testid="rail.nav-row"]').length,
    tree: document.querySelectorAll('[data-testid="tree.thumbnail"][data-source="render"]').length,
    inspector: document.querySelector('[data-testid="insp.thumbnail"]')?.getAttribute("data-source") ?? null,
  };
}

/** The chips live in the guest (checked by `stageEmbedPane`), not in the host DOM. */
function thumbnailFailures(t: ReturnType<typeof readThumbs>): string[] {
  const f: string[] = [];
  if (t.tree !== t.rows) f.push(`tree: ${t.tree} of ${t.rows} rows show a rendered thumbnail`);
  if (t.inspector !== "render") f.push(`inspector card: ${t.inspector ?? "missing"} (want render)`);
  return f;
}
