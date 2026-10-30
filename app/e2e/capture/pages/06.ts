/**
 * Bar capture state for page 06 (Simulate > Propulsion simulation, Visual
 * flow tier, concept 06; spec B1, plan M5.5): the seeded live research
 * vehicle (M1.55) with its visual flow study "Study 01"
 * (`sims/study_01.rw.toml`, kind = "visual_flow", scripted tilt, D10c) run
 * through `sim.run` (a `provenance = "visual"` run), the WebGPU cutaway with
 * every layer on and the section view on, the Traces tab with the label
 * "Visual model · Not an engineering result", and the "Tank motion" thread
 * open.
 *
 * Motion (D26): from the start the study plays at 1x for 5 s while the
 * script reads 20 frames of the live canvas (`__rwFluid.snapshot`, the
 * final tone-mapped output; the DOM labels are not in it) into a contact
 * sheet, `motion.png` in the page's output directory (`drive.clip`). Then
 * the transport is scrubbed back and played into mid-playback, pausing in
 * the page on the first frame past `PAUSE_AT` (the liquid is in motion,
 * not re-settled from a seek), and the still is captured there.
 *
 * The agent pane is the Lecturn embed (B10): the threads come from the
 * 06 bundle and the pane's live state from `scripted/visual-06.json` (B13,
 * `../embed.ts`; CPW1R3A): the tank-motion turn, its Study 01 and render
 * tool rows, the run card's view form 'Section view · Study 01' (Open goes
 * to the study's section view) and the profile render card, the reply, an
 * engine run's pending approval and the `rw:c/fins` chip, checked in the
 * guest after staging and again before the still.
 *
 * A desktop `--drive` module (`make bar-visual PAGES=06`). Navigation and
 * threads go through the `app_*` broker hooks; the transport is driven
 * through its own controls (scrubber, Play/Pause), as a user would; the
 * waits read the page's DOM state (never faked).
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { grid, resize } from "../../../apps/web/spikes/recovery-bay/compose.ts";
import { decodePng, encodePng } from "../../bar/png.ts";
import { stageEmbedPane, verifyEmbedPane } from "../embed.ts";
import { Hooks, requireEmbed, settle, waitFor, type DriveContext } from "../hooks.ts";

export const STATE = {
  page: "propulsion-sim",
  tier: "visual",
  study: "study_01",
  studyName: "Study 01",
  layers: ["shell", "section", "flow", "labels"],
  sub: "traces",
  provenance: "visual",
  thread: "Tank motion",
} as const;

/** The still: played from `PLAY_FROM` and paused on the first frame past `PAUSE_AT` (s of study time). */
export const PLAY_FROM = 1.0;
export const PAUSE_AT = 2.4;
/** Motion clip: frames, spacing (ms), and frame size (px). */
export const CLIP = { frames: 20, everyMs: 250, w: 360, h: 232, perRow: 5 } as const;

function readState(): Record<string, unknown> {
  const q = (sel: string) => document.querySelector<HTMLElement>(sel);
  const all = (sel: string) => Array.from(document.querySelectorAll<HTMLElement>(sel));
  return {
    tier: q('[data-testid="propsim-page"]')?.dataset["tier"] ?? null,
    visual: { state: q('[data-testid="propsim.visual"]')?.dataset["state"] ?? null, study: q('[data-testid="propsim.visual"]')?.dataset["study"] ?? null, provenance: q('[data-testid="propsim.visual"]')?.dataset["provenance"] ?? null },
    viewport: { state: q('[data-testid="visual.viewport"]')?.dataset["state"] ?? null, backend: q('[data-testid="visual.viewport"]')?.dataset["backend"] ?? null, section: q('[data-testid="visual.viewport"]')?.dataset["section"] ?? null },
    gpuError: q('[data-testid="visual.gpu-error"]')?.textContent ?? null,
    error: q('[data-testid="visual.error"]')?.textContent ?? null,
    layers: all('[data-testid="visual.layer"]').map((l) => `${l.dataset["layer"]}:${String((l as HTMLInputElement).checked)}`),
    labels: all('[data-testid="visual.label"]').map((l) => `${l.dataset["label"]}:${l.style.visibility}`),
    sub: q('[data-testid="visual.subtab"][aria-selected="true"]')?.dataset["sub"] ?? null,
    provenanceLabel: q('[data-testid="traces.provenance"]')?.textContent ?? null,
    transport: { t: q('[data-testid="transport"]')?.dataset["t"] ?? null, playing: q('[data-testid="transport"]')?.dataset["playing"] ?? null, clock: q('[data-testid="transport.clock"]')?.textContent ?? null },
    rail: all('[data-testid="rail.nav-row"]').map((r) => `${r.dataset["row"]}:${r.getAttribute("aria-selected")}`),
    thread: q('[data-testid="agent.title"]')?.textContent?.trim() ?? null,
    threads: all('[data-testid="rail.thread"]').map((t) => t.textContent?.trim() ?? ""),
  };
}

/** Plays from `from` (set like a scrubber drag: React reads the native input event) and pauses in the page, on the frame, once the transport passes `to`. */
function playInto({ from, to }: { from: number; to: number }): Promise<number> {
  const transport = () => document.querySelector<HTMLElement>('[data-testid="transport"]')!;
  const play = () => document.querySelector<HTMLButtonElement>('[data-testid="transport.play"]')!;
  const scrub = document.querySelector<HTMLInputElement>('[data-testid="transport.scrubber"]')!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(scrub, String(from));
  scrub.dispatchEvent(new Event("input", { bubbles: true }));
  return new Promise((done, fail) => {
    const deadline = performance.now() + 30_000;
    requestAnimationFrame(() => {
      if (transport().dataset["playing"] !== "true") play().click();
      const tick = () => {
        const t = Number(transport().dataset["t"]);
        if (t >= to) {
          if (transport().dataset["playing"] === "true") play().click();
          done(t);
        } else if (performance.now() > deadline) fail(new Error(`transport stuck at ${String(t)}`));
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  });
}

/** Plays from the start at 1x and reads `frames` canvas frames `everyMs` apart (PNG base64); pauses after. */
async function recordClip(c: { frames: number; everyMs: number; w: number; h: number }): Promise<{ frames: string[]; times: number[] }> {
  // `window.__rwFluid` (apps/web/src/pages/propsim/visual.tsx `FluidProbe`), as this script reads it.
  const probe = (window as unknown as { __rwFluid?: { snapshot(w: number, h: number): Promise<string> } }).__rwFluid;
  if (!probe) throw new Error("no fluid probe");
  const transport = () => document.querySelector<HTMLElement>('[data-testid="transport"]')!;
  const play = () => document.querySelector<HTMLButtonElement>('[data-testid="transport.play"]')!;
  document.querySelector<HTMLButtonElement>('[data-testid="transport.speed"][data-speed="1"]')?.click();
  const scrub = document.querySelector<HTMLInputElement>('[data-testid="transport.scrubber"]')!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(scrub, "0");
  scrub.dispatchEvent(new Event("input", { bubbles: true }));
  await new Promise((r) => requestAnimationFrame(r));
  if (transport().dataset["playing"] !== "true") play().click();
  const frames: string[] = [];
  const times: number[] = [];
  const t0 = performance.now();
  for (let i = 0; i < c.frames; i++) {
    const wait = t0 + i * c.everyMs - performance.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    frames.push(await probe.snapshot(c.w, c.h));
    times.push(Number(transport().dataset["t"]));
  }
  if (transport().dataset["playing"] === "true") play().click();
  return { frames, times };
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
    // B13: the embed's threads are the 06 bundle, its live state the visual-06 scenario (checked in the guest).
    const staged = await stageEmbedPane(ctx, hooks, { page: "06", scenario: "visual-06" });
    const threads = staged["threads"];
    await waitFor(
      page,
      "page 06 Visual flow state (Study 01 run as a visual run, WebGPU cutaway with every layer on, Traces, Tank motion)",
      (want) => {
        const q = (sel: string) => document.querySelector<HTMLElement>(sel);
        const vis = q('[data-testid="propsim.visual"]');
        const vp = q('[data-testid="visual.viewport"]');
        const layers = Array.from(document.querySelectorAll<HTMLInputElement>('[data-testid="visual.layer"]'));
        return (
          q('[data-testid="propsim-page"]')?.dataset["tier"] === "visual" &&
          vis?.dataset["state"] === "ready" &&
          vis.dataset["study"] === want.study &&
          vis.dataset["provenance"] === want.provenance &&
          vp?.dataset["state"] === "ready" &&
          vp.dataset["backend"] === "webgpu" &&
          vp.dataset["section"] === "true" &&
          layers.length === 4 &&
          layers.every((l) => l.checked) &&
          q('[data-testid="visual.subtab"][aria-selected="true"]')?.dataset["sub"] === want.sub &&
          Array.from(document.querySelectorAll<HTMLElement>('[data-testid="visual.label"]')).every((l) => l.style.visibility === "visible") &&
          document.querySelectorAll('[data-testid="rail.thread"]').length >= 3 &&
          ((window as unknown as { __rwFluid?: { stats(): { frames: number } | null } }).__rwFluid?.stats()?.frames ?? 0) > 60
        );
      },
      { study: STATE.study, provenance: STATE.provenance, sub: STATE.sub },
      { timeoutMs: 180_000, diag: readState },
    );

    // Motion clip (D26) on the live canvas, then the contact sheet beside the capture.
    const clip = await page.evaluate(recordClip, { frames: CLIP.frames, everyMs: CLIP.everyMs, w: CLIP.w, h: CLIP.h });
    let clipFile: string | null = null;
    const outDir = process.env["RW_BAR_CAPTURE_DIR"];
    const decoded = clip.frames.filter((f) => f !== "").map((f) => resize(decodePng(Buffer.from(f, "base64")), CLIP.w, CLIP.h));
    if (outDir && decoded.length > 0) {
      const rows = [];
      for (let i = 0; i < decoded.length; i += CLIP.perRow) rows.push(decoded.slice(i, i + CLIP.perRow));
      clipFile = "motion.png";
      writeFileSync(join(outDir, clipFile), encodePng(grid(rows, 6)));
    }

    // The still: mid-playback, paused in the page on the frame.
    const pausedAt = await page.evaluate(playInto, { from: PLAY_FROM, to: PAUSE_AT });
    // The pane's state again, right before the still (the clip and playback ran meanwhile).
    const pane = { ...staged, ...(await verifyEmbedPane(ctx, "visual-06")) };
    await settle(page, 600);
    return {
      state: { ...STATE, pausedAt: Number(pausedAt.toFixed(2)) },
      threads,
      clip: clipFile,
      clipTimes: clip.times.map((t) => Number(t.toFixed(2))),
      clipFrames: decoded.length,
      dom: await page.evaluate(readState, null),
      pane,
    };
  } finally {
    hooks.close();
  }
}
