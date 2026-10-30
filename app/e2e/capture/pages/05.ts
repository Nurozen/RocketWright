/**
 * Bar capture state for page 05 (Propulsion > Liquid propulsion design,
 * concept 05; spec B1): the seeded live research vehicle (M1.55) with its
 * incomplete engine `engines/demo-incomplete.rw.toml` (D10b: fluid model and
 * the first line's boundary condition unset, so the check reports RW-W210
 * and RW-W211), the System tab, the connection Tank A → Engine selected (its
 * first line, so Feed system is the selected rail row), and the "Feed system
 * review" thread open (the strip's Missing inputs · 2 row comes from the
 * live check).
 *
 * A desktop `--drive` module (`make bar-visual PAGES=05`): navigation,
 * selection, and threads go through the `app_*` broker hooks; the waits read
 * the page's own DOM state (never faked).
 *
 * The agent pane is the Lecturn embed (B10): the thread comes from the
 * page's bundle (`hooks.seedBundle` through `seedEmbedThreads`, B13/B15)
 * and the guest is checked to show it.
 */
import { seedEmbedThreads } from "../embed.ts";
import { Hooks, requireEmbed, settle, waitFor, type DriveContext } from "../hooks.ts";

export const ENGINE = "demo-incomplete";
export const STATE = {
  page: "liquid",
  tab: "system",
  engine: ENGINE,
  select: `rw:eng/${ENGINE}/feed/edge/0`,
  selected: "edge:0,edge:1",
  missing: "2",
  thread: "Feed system review",
} as const;

function readState(): Record<string, unknown> {
  const q = (sel: string) => document.querySelector<HTMLElement>(sel);
  return {
    page: q('[data-testid="liquid-page"]')?.dataset["engine"] ?? null,
    tab: q('[data-testid="liquid-page"]')?.dataset["tab"] ?? null,
    viewport: { ready: q('[data-testid="viewport"]')?.dataset["ready"] ?? null, selected: q('[data-testid="viewport"]')?.dataset["selected"] ?? null, render: q('[data-testid="viewport"]')?.dataset["render"] ?? null },
    labels: Array.from(document.querySelectorAll('[data-testid="vp.leader-label"]')).map((l) => l.textContent?.trim() ?? ""),
    rail: Array.from(document.querySelectorAll<HTMLElement>('[data-testid="rail.nav-row"]')).map((r) => `${r.dataset["category"]}:${r.getAttribute("aria-selected")}`),
    from: q('[data-testid="insp.connection"]')?.dataset["from"] ?? null,
    to: q('[data-testid="insp.connection"]')?.dataset["to"] ?? null,
    inputs: Array.from(document.querySelectorAll<HTMLElement>('[data-testid="insp.input"]')).map((r) => `${r.dataset["key"]}:${r.dataset["tone"]}`),
    missing: q('[data-testid="agent.missing-inputs"]')?.dataset["count"] ?? null,
    thread: q('[data-testid="agent.title"]')?.textContent?.trim() ?? null,
    threads: Array.from(document.querySelectorAll('[data-testid="rail.thread"]')).map((t) => t.textContent?.trim() ?? ""),
    history: document.querySelectorAll('[data-testid="agent.thread-history-item"]').length,
  };
}

export default async function drive(ctx: DriveContext): Promise<Record<string, unknown>> {
  const { page } = ctx;
  const hooks = await Hooks.open(ctx.rpcUrl);
  try {
    await hooks.call("app_navigate", { page: STATE.page, tab: STATE.tab });
    await waitFor(
      page,
      "the Liquid propulsion page on the live project",
      () => {
        const name = document.querySelector('[data-testid="header.project-switcher"]')?.textContent?.trim() ?? "";
        return document.querySelector('[data-testid="liquid-page"]') !== null && name !== "" && !/^(Opening…|No project)$/.test(name);
      },
      null,
      { timeoutMs: 90_000, diag: readState },
    );
    await requireEmbed(page);
    // B15: the page's Lecturn bundle; the guest shows its last thread.
    const threads = (await seedEmbedThreads(ctx, hooks, "05")).threads;
    await hooks.call("app_select", { ref: STATE.select });
    await waitFor(
      page,
      "page 05 state (demo-incomplete, Tank A → Engine selected, Missing inputs · 2, Feed system review)",
      (want) => {
        const vp = document.querySelector<HTMLElement>('[data-testid="viewport"]');
        return (
          document.querySelector<HTMLElement>('[data-testid="liquid-page"]')?.dataset["engine"] === want.engine &&
          vp?.dataset["ready"] === "true" &&
          (vp.dataset["modelKey"] ?? "").startsWith(`${want.engine}@`) &&
          !(vp.dataset["modelKey"] ?? "").endsWith(":none") &&
          vp.dataset["selected"] === want.selected &&
          document.querySelector<HTMLElement>('[data-testid="insp.connection"]')?.dataset["from"] === "tank_a" &&
          document.querySelector<HTMLElement>('[data-testid="agent.missing-inputs"]')?.dataset["count"] === want.missing &&
          document.querySelector('[data-testid="agent.title"]')?.textContent?.trim() === want.thread &&
          document.querySelectorAll('[data-testid="vp.leader-label"]').length === 3 &&
          document.querySelectorAll('[data-testid="rail.thread"]').length >= 3
        );
      },
      { engine: STATE.engine, selected: STATE.selected, missing: STATE.missing, thread: STATE.thread },
      { timeoutMs: 120_000, diag: readState },
    );
    await settle(page, 1200);
    return { state: STATE, threads, dom: await page.evaluate(readState, null) };
  } finally {
    hooks.close();
  }
}
