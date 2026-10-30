/**
 * Bar capture state for page 03 (Design > Configurations, concept 03; spec
 * B1): the seeded live research vehicle (M1.55) with its three
 * configurations (Baseline and Higher altitude simulated on the current
 * model; Recovery test never run), Baseline selected, the Motors sub-tab
 * showing Baseline's own mounted motor (R19-03: the detail follows
 * `configs.baseline.motors.<mount>.motor`, RW_B4G: its row highlighted with
 * the assigned check, thrust curve, casing on the studio stage, mount
 * silhouette, Assigned), and the "Motor comparison" thread open (Run
 * configurations in the pane strip).
 *
 * A desktop `--drive` module (`make bar-visual PAGES=03`): navigation,
 * selection, and threads go through the `app_*` broker hooks; the waits read
 * the page's own DOM state (never faked).
 *
 * The agent pane is the Lecturn embed (B10): the thread comes from the
 * page's bundle (`hooks.seedBundle` through `seedEmbedThreads`, B13/B15)
 * and the guest is checked to show it.
 */
import { seedEmbedThreads } from "../embed.ts";
import { Hooks, requireEmbed, settle, waitFor, type DriveContext } from "../hooks.ts";

export const STATE = { page: "configurations", select: "rw:cfg/baseline", config: "baseline", motor: "generic:RW_B4G", thread: "Motor comparison" } as const;

function readState(): Record<string, unknown> {
  return {
    page: document.querySelector('[data-testid="configurations-page"]') !== null,
    rows: Array.from(document.querySelectorAll<HTMLElement>('[data-testid="configs.row"]')).map((r) => `${r.dataset["config"]}:${r.dataset["status"]}:${r.getAttribute("aria-checked")}`),
    subtab: document.querySelector('[data-testid="configs.subtab"][aria-selected="true"]')?.textContent?.trim() ?? null,
    motors: document.querySelector<HTMLElement>('[data-testid="motors.list"]')?.dataset["state"] ?? null,
    motor: document.querySelector<HTMLElement>('[data-testid="motor.detail"]')?.dataset["motor"] ?? null,
    mounted: document.querySelector<HTMLElement>('[data-testid="motor-panel"]')?.dataset["assigned"] ?? null,
    curve: document.querySelector<HTMLElement>('[data-testid="motor.thrust-curve"]')?.dataset["points"] ?? null,
    assign: document.querySelector<HTMLElement>('[data-testid="motor.assign"]')?.dataset["state"] ?? null,
    casing: (() => {
      const c = document.querySelector<HTMLElement>('[data-testid="motor.casing"]');
      return c ? `${c.dataset["source"] ?? "svg"}:${c.dataset["ready"] ?? ""}` : null;
    })(),
    thread: document.querySelector('[data-testid="agent.title"]')?.textContent?.trim() ?? null,
    threads: Array.from(document.querySelectorAll('[data-testid="rail.thread"]')).map((t) => t.textContent?.trim() ?? ""),
  };
}

export default async function drive(ctx: DriveContext): Promise<Record<string, unknown>> {
  const { page } = ctx;
  const hooks = await Hooks.open(ctx.rpcUrl);
  try {
    await hooks.call("app_navigate", { page: STATE.page });
    await waitFor(
      page,
      "the Configurations page on the live project",
      () => {
        const name = document.querySelector('[data-testid="header.project-switcher"]')?.textContent?.trim() ?? "";
        return document.querySelector('[data-testid="configurations-page"]') !== null && name !== "" && !/^(Opening…|No project)$/.test(name);
      },
      null,
      { timeoutMs: 90_000, diag: readState },
    );
    await requireEmbed(page);
    // B15: the page's Lecturn bundle; the guest shows its last thread.
    const threads = (await seedEmbedThreads(ctx, hooks, "03")).threads;
    await hooks.call("app_select", { ref: STATE.select });
    await waitFor(
      page,
      "page 03 state (three configurations with run status, Baseline selected, Motors with its curve, Motor comparison thread)",
      (want) =>
        document.querySelectorAll('[data-testid="configs.row"]').length === 3 &&
        document.querySelector(`[data-testid="configs.row"][data-config="${want.config}"]`)?.getAttribute("aria-checked") === "true" &&
        document.querySelector('[data-testid="configs.row"][data-status="simulated"]') !== null &&
        document.querySelector('[data-testid="motors.list"]')?.getAttribute("data-state") === "ready" &&
        document.querySelector('[data-testid="motor.thrust-curve"]') !== null &&
        document.querySelector('[data-testid="agent.title"]')?.textContent?.trim() === want.thread &&
        document.querySelector('[data-testid="agent.run-configurations"]') !== null &&
        document.querySelectorAll('[data-testid="rail.thread"]').length === 4,
      { config: STATE.config, thread: STATE.thread },
      { timeoutMs: 120_000, diag: readState },
    );
    // The detail shows the selected configuration's mounted motor (never a stale candidate), on the studio stage.
    await waitFor(
      page,
      "Baseline's mounted motor in the detail (Assigned) with its casing rendered",
      (want) => {
        const casing = document.querySelector<HTMLElement>('[data-testid="motor.casing"]');
        const detail = document.querySelector<HTMLElement>('[data-testid="motor.detail"]')?.dataset["motor"];
        return (
          detail === want.motor &&
          detail === document.querySelector<HTMLElement>('[data-testid="motor-panel"]')?.dataset["assigned"] &&
          document.querySelector<HTMLElement>(`[data-testid="motors.row"][data-motor="${want.motor}"][aria-selected="true"] [data-testid="motors.assigned"]`) !== null &&
          document.querySelector<HTMLElement>('[data-testid="motor.assign"]')?.dataset["state"] === "assigned" &&
          casing !== null &&
          (casing.dataset["source"] === undefined || casing.dataset["ready"] === "true")
        );
      },
      { motor: STATE.motor },
      { timeoutMs: 60_000, diag: readState },
    );
    await settle(page, 600);
    return { state: STATE, threads, dom: await page.evaluate(readState, null) };
  } finally {
    hooks.close();
  }
}
