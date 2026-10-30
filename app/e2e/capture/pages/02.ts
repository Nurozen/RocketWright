/**
 * Bar capture state for page 02 (Design > Components, concept 02; spec B1):
 * the seeded live research vehicle (M1.55) with Fins selected after the
 * seeded fin revision (step 03: span 90 -> 100 mm, sweep 45 -> 40 mm), so the
 * profile shows the new fin set in teal over the dashed amber ghost of step
 * 02, the editor reads Modified, and the agent pane has the Changed fields
 * card and this thread's history. The "Fin revision" thread is open; the
 * rail lists the concept's three threads.
 *
 * A desktop `--drive` module (`make bar-visual PAGES=02`): navigation,
 * selection, and threads go through the `app_*` broker hooks; the waits read
 * the page's own DOM state (never faked).
 *
 * The agent pane is the Lecturn embed (B10): the thread comes from the
 * page's bundle (`hooks.seedBundle` through `seedEmbedThreads`, B13/B15)
 * and the guest is checked to show it.
 */
import { seedEmbedThreads } from "../embed.ts";
import { Hooks, requireEmbed, settle, waitFor, type DriveContext } from "../hooks.ts";

export const STATE = { page: "components", select: "rw:c/fins", part: "fins", thread: "Fin revision", view: "side" } as const;

function readState(): Record<string, unknown> {
  const vp = document.querySelector<HTMLElement>('[data-testid="viewport"]');
  return {
    page: document.querySelector('[data-testid="components-page"]') !== null,
    ready: vp?.dataset["ready"] ?? null,
    render: vp?.dataset["render"] ?? null,
    view: vp?.dataset["view"] ?? null,
    selected: vp?.dataset["selected"] ?? null,
    ghost: vp?.dataset["ghost"] ?? null,
    error: vp?.dataset["error"] ?? null,
    editor: document.querySelector<HTMLElement>('[data-testid="editor"]')?.dataset["part"] ?? null,
    status: document.querySelector('[data-testid="editor.status"]')?.textContent?.trim() ?? null,
    fields: Array.from(document.querySelectorAll<HTMLElement>('[data-testid="editor.field"]')).map((f) => `${f.dataset["field"]}=${f.querySelector("input")?.value ?? f.querySelector("select")?.value ?? ""}`),
    changed: document.querySelector('[data-testid="agent.changed-fields"]')?.textContent?.trim() ?? null,
    history: Array.from(document.querySelectorAll('[data-testid="agent.thread-history-item"]')).map((e) => e.textContent?.trim() ?? ""),
    thread: document.querySelector('[data-testid="agent.title"]')?.textContent?.trim() ?? null,
    threads: Array.from(document.querySelectorAll('[data-testid="rail.thread"]')).map((t) => t.textContent?.trim() ?? ""),
    cg: document.querySelector<HTMLElement>('[data-testid="vp.cg"]')?.dataset["station"] ?? null,
    cp: document.querySelector<HTMLElement>('[data-testid="vp.cp"]')?.dataset["station"] ?? null,
  };
}

export default async function drive(ctx: DriveContext): Promise<Record<string, unknown>> {
  const { page } = ctx;
  const hooks = await Hooks.open(ctx.rpcUrl);
  try {
    await hooks.call("app_navigate", { page: STATE.page });
    await waitFor(
      page,
      "the Components page on the live project",
      () => {
        const name = document.querySelector('[data-testid="header.project-switcher"]')?.textContent?.trim() ?? "";
        return document.querySelector('[data-testid="components-page"]') !== null && name !== "" && !/^(Opening…|No project)$/.test(name);
      },
      null,
      { timeoutMs: 90_000, diag: readState },
    );
    await requireEmbed(page);
    // B15: the page's Lecturn bundle; the guest shows its last thread.
    const threads = (await seedEmbedThreads(ctx, hooks, "02")).threads;
    await hooks.call("app_select", { ref: STATE.select });
    await waitFor(
      page,
      "page 02 state (Fins selected with the step 03 proposal and its ghost, Fin revision thread, three threads)",
      (want) => {
        const vp = document.querySelector<HTMLElement>('[data-testid="viewport"]');
        return (
          vp?.dataset["ready"] === "true" &&
          vp.dataset["selected"] === want.part &&
          vp.dataset["view"] === want.view &&
          vp.dataset["ghost"] === "true" &&
          document.querySelector<HTMLElement>('[data-testid="editor"]')?.dataset["part"] === want.part &&
          document.querySelector<HTMLElement>('[data-testid="editor.status"]')?.dataset["kind"] === "modified" &&
          document.querySelector('[data-testid="vp.cg"]') !== null &&
          document.querySelector('[data-testid="agent.changed-fields"]') !== null &&
          document.querySelector('[data-testid="agent.title"]')?.textContent?.trim() === want.thread &&
          document.querySelectorAll('[data-testid="rail.thread"]').length === 3
        );
      },
      { part: STATE.part, view: STATE.view, thread: STATE.thread },
      { timeoutMs: 120_000, diag: readState },
    );
    await settle(page, 800);
    return { state: STATE, threads, dom: await page.evaluate(readState, null) };
  } finally {
    hooks.close();
  }
}
