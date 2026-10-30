/**
 * Bar capture state for page 04 (Results, concept 04; spec B1): the seeded
 * live research vehicle (M1.55: Baseline and Higher altitude Complete on the
 * current model, Fin revision Outdated by step 03, Recovery test Not run),
 * Baseline and Higher altitude overlaid (teal, sand) with Baseline selected
 * (the run the rail, table, and details describe), and the "Flight
 * comparison" thread open in the pane. The run table lists runs only; never-run Recovery test is in
 * the Runs rail.
 *
 * A desktop `--drive` module (`make bar-visual PAGES=04`). The runs are the
 * seed's real runs (no `sim.run` here); the overlay, page, and thread go
 * through the `app_*` broker hooks. A run that is not in its seeded state is
 * reported as `pending` (never faked).
 *
 * The agent pane is the Lecturn embed (B10): the thread comes from the
 * page's bundle (`hooks.seedBundle` through `seedEmbedThreads`, B13/B15)
 * and the guest is checked to show it.
 */
import { seedEmbedThreads } from "../embed.ts";
import { Hooks, requireEmbed, settle, waitFor, type DriveContext } from "../hooks.ts";

export const SIMS = ["baseline", "higher_altitude"] as const;
/** The seeded run statuses (fixtures/research-vehicle/seed.expected.json). */
export const SEEDED = { baseline: "complete", higher_altitude: "complete", fin_revision: "outdated", recovery_test: "not_run" } as const;

/** Run table, overlay, and plot state (runs in the page). */
function readState(): Record<string, unknown> {
  const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="runs.table-row"]')).map((r) => ({
    sim: r.dataset["sim"] ?? null,
    status: r.dataset["status"] ?? null,
    series: r.dataset["series"] ?? null,
  }));
  const rail = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="rail.nav-row"]')).map((r) => ({
    sim: r.dataset["sim"] ?? null,
    status: r.dataset["status"] ?? null,
    selected: r.getAttribute("aria-selected") === "true",
  }));
  const plot = document.querySelector<HTMLElement>('[data-testid="plot"]');
  return {
    page: document.querySelector('[data-testid="results-page"]') !== null,
    rows,
    rail,
    threads: Array.from(document.querySelectorAll('[data-testid="rail.thread"]')).map((t) => t.textContent?.trim() ?? ""),
    plotLoading: plot?.dataset["loading"] ?? null,
    // The trajectory inset's render facts (backend, pad, rail, contact shadow).
    inset: { ...document.querySelector<HTMLElement>('[data-testid="inset.trajectory"]')?.dataset },
    series: document.querySelectorAll('[data-testid="plot.series"]').length,
    plotEmpty: document.querySelector('[data-testid="plot.empty"]')?.textContent?.trim() ?? null,
    thread: document.querySelector('[data-testid="agent.title"]')?.textContent?.trim() ?? null,
    reply: document.querySelector('[data-testid="agent.reply"]')?.textContent?.trim() ?? null,
  };
}

export default async function drive(ctx: DriveContext): Promise<Record<string, unknown>> {
  const { page } = ctx;
  const hooks = await Hooks.open(ctx.rpcUrl);
  try {
    await hooks.call("app_navigate", { page: "results" });
    await waitFor(
      page,
      "the Results page on the live project",
      () => {
        const name = document.querySelector('[data-testid="header.project-switcher"]')?.textContent?.trim() ?? "";
        return document.querySelector('[data-testid="results-page"]') !== null && name !== "" && !/^(Opening…|No project)$/.test(name);
      },
      null,
      { timeoutMs: 90_000, diag: readState },
    );
    await waitFor(
      page,
      `the seeded runs (${Object.entries(SEEDED).map(([s, st]) => `${s} ${st}`).join(", ")})`,
      // The Runs rail lists every sim (the table only those with runs).
      (want) => Object.entries(want).every(([s, st]) => document.querySelector(`[data-testid="rail.nav-row"][data-sim="${s}"]`)?.getAttribute("data-status") === st),
      SEEDED as Record<string, string>,
      { timeoutMs: 120_000, diag: readState },
    );
    // Overlay every requested run that is Complete (A teal, then B sand).
    const complete = (await page.evaluate(
      (sims) => sims.filter((s) => document.querySelector(`[data-testid="runs.table-row"][data-sim="${s}"]`)?.getAttribute("data-status") === "complete"),
      [...SIMS],
    )) as string[];
    for (const sim of complete) await hooks.call("app_select", { ref: `rw:sim/${sim}` });
    // Selecting an overlaid run again keeps the overlay: Baseline (series A) is the selected run.
    if (complete[0] !== undefined) await hooks.call("app_select", { ref: `rw:sim/${complete[0]}` });
    await requireEmbed(page);
    // B15: the page's Lecturn bundle; the guest shows its last thread.
    const threads = (await seedEmbedThreads(ctx, hooks, "04")).threads;
    await waitFor(
      page,
      "page 04 state (overlay, Flight comparison)",
      (want) => {
        const overlaid = want.sims.every((s) => document.querySelector(`[data-testid="runs.table-row"][data-sim="${s}"]`)?.hasAttribute("data-series"));
        const plot = document.querySelector<HTMLElement>('[data-testid="plot"]');
        const selected = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="rail.nav-row"][aria-selected="true"]')).map((r) => r.dataset["sim"]);
        return (
          overlaid &&
          plot?.dataset["loading"] !== "true" &&
          document.querySelector('[data-testid="agent.title"]')?.textContent?.trim() === want.thread &&
          document.querySelectorAll('[data-testid="rail.thread"]').length === 3 &&
          (want.sims[0] === undefined || (selected.length === 1 && selected[0] === want.sims[0]))
        );
      },
      { sims: complete, thread: "Flight comparison" },
      { diag: readState },
    );
    // The studio renders: the inset shaded (ready), and the run cards' rocket from the thumbnail
    // cache (rendered once per model; `unavailable` without WebGPU keeps the glyph).
    await waitFor(
      page,
      "the trajectory inset and the run snapshot thumbnails rendered",
      () => {
        const inset = document.querySelector<HTMLElement>('[data-testid="inset.trajectory"]')?.dataset["ready"];
        const thumbs = document.querySelector<HTMLElement>('[data-testid="thumbs.status"]')?.dataset["state"];
        const cards = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="history.snapshot-thumb"]'));
        return (inset === "true" || inset === "error") && (thumbs === "unavailable" || (cards.length > 0 && cards.every((c) => c.dataset["source"] === "render")));
      },
      null,
      { timeoutMs: 90_000, diag: readState },
    );
    await settle(page, 800);
    const pending = SIMS.filter((s) => !complete.includes(s));
    return { overlaid: complete, pending, threads, dom: await page.evaluate(readState, null) };
  } finally {
    hooks.close();
  }
}
