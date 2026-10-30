/**
 * Bar capture state for page 06's Engineering tier (Simulate > Propulsion
 * simulation, M4.8; concept 06 has no art for this tier, C §6): the seeded
 * live research vehicle (M1.55), the complete demo engine's tank blowdown
 * from `engine_simulate` (tank pressure, mass flow, thrust over time;
 * provenance engineering), and the "Tank motion" thread open (the 06
 * Lecturn bundle's last thread in the embedded pane, B13; B17 removed the
 * old chat's seeded threads).
 *
 * A desktop `--drive` module (`make bar-visual PAGES=06-engineering`). The
 * run is the page's own `engine.simulate`; the waits read the page's DOM
 * state (never faked).
 */
import { seedEmbedThreads } from "../embed.ts";
import { Hooks, requireEmbed, settle, waitFor, type DriveContext } from "../hooks.ts";

export const STATE = { page: "propulsion-sim", tier: "engineering", engine: "demo", plots: 3, thread: "Tank motion" } as const;

function readState(): Record<string, unknown> {
  const eng = document.querySelector<HTMLElement>('[data-testid="propsim.engineering"]');
  return {
    tier: document.querySelector<HTMLElement>('[data-testid="propsim-page"]')?.dataset["tier"] ?? null,
    engine: eng?.dataset["engine"] ?? null,
    state: eng?.dataset["state"] ?? null,
    provenance: eng?.dataset["provenance"] ?? null,
    plots: Array.from(document.querySelectorAll<HTMLElement>('[data-testid="engineering.plot"]')).map((p) => `${p.dataset["plot"]}:${p.dataset["series"]}:${p.dataset["points"]}`),
    error: document.querySelector('[data-testid="engineering.error"]')?.textContent?.trim() ?? null,
    thread: document.querySelector('[data-testid="agent.title"]')?.textContent?.trim() ?? null,
    threads: Array.from(document.querySelectorAll('[data-testid="rail.thread"]')).map((t) => t.textContent?.trim() ?? ""),
  };
}

export default async function drive(ctx: DriveContext): Promise<Record<string, unknown>> {
  const { page } = ctx;
  const hooks = await Hooks.open(ctx.rpcUrl);
  try {
    await hooks.call("app_navigate", { page: STATE.page, tab: STATE.tier });
    await waitFor(
      page,
      "the Propulsion simulation page on the live project",
      () => {
        const name = document.querySelector('[data-testid="header.project-switcher"]')?.textContent?.trim() ?? "";
        return document.querySelector('[data-testid="propsim-page"]') !== null && name !== "" && !/^(Opening…|No project)$/.test(name);
      },
      null,
      { timeoutMs: 90_000, diag: readState },
    );
    await requireEmbed(page);
    const threads = (await seedEmbedThreads(ctx, hooks, "06")).threads;
    await waitFor(
      page,
      "page 06 Engineering state (the demo engine's blowdown in three plots, Tank motion)",
      (want) => {
        const eng = document.querySelector<HTMLElement>('[data-testid="propsim.engineering"]');
        return (
          eng?.dataset["engine"] === want.engine &&
          eng.dataset["state"] === "ready" &&
          eng.dataset["provenance"] === "engineering" &&
          document.querySelectorAll('[data-testid="engineering.plot"] canvas').length >= want.plots &&
          document.querySelector('[data-testid="agent.title"]')?.textContent?.trim() === want.thread
        );
      },
      { engine: STATE.engine, plots: STATE.plots, thread: STATE.thread },
      { timeoutMs: 120_000, diag: readState },
    );
    await settle(page, 800);
    return { state: STATE, threads, dom: await page.evaluate(readState, null) };
  } finally {
    hooks.close();
  }
}
