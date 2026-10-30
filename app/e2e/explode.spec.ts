/**
 * M3.2 exploded-view animation on the live page 01 (web bundle, app server,
 * seeded research vehicle). The Assembled/Exploded buttons ease the explode
 * factor (cubic in-out, M3.0 spacing at every frame); the slider still
 * jumps. Both specs pin the tween's normalised time (`seekExplode`, the
 * injectable clock) and assert the curve at fixed sample times, never by
 * counting real-time frames (that flaked under GPU load), so clip frames are
 * deterministic; the clip is written to `.playwright/m3/explode/`
 * and the motion axis is checked on it: parts separate along the assembly
 * axis, in order, never overlapping.
 */
import { expect, test, type Page } from "@playwright/test";
import { explodeAt } from "../apps/web/src/viewport/explodeAnim.ts";
import { frames, openAssembly, saveArtifact, viewport, vp } from "./viewport-helpers.ts";

interface AnimState {
  shown: number;
  target: number;
  running: boolean;
  paused: boolean;
  t: number;
}

const anim = (page: Page) => vp<AnimState>(page, "explodeAnim");

test.beforeEach(async ({ page }) => {
  await openAssembly(page);
  test.skip((await vp<string>(page, "backend")) === "none", "the tween runs in the render loop (needs a renderer)");
});

/** Samples of the eased curve: the tween is pinned at each `t` (no wall clock), so the check holds under any load. */
const CURVE_TS = [0, 0.1, 0.25, 0.4, 0.5, 0.6, 0.75, 0.9, 1];

async function curveAt(page: Page, ts: readonly number[]): Promise<number[]> {
  const out: number[] = [];
  for (const t of ts) {
    await vp(page, "seekExplode", t);
    await frames(page);
    const a = await anim(page);
    expect(a.paused, `t=${t}`).toBe(true);
    expect(a.running, `t=${t}`).toBe(true);
    out.push(a.shown);
  }
  return out;
}

test("Exploded and Assembled buttons ease the explode on the clock", async ({ page }) => {
  expect((await anim(page)).shown).toBe(0);
  // Pin the injectable clock before the click: the button's tween holds at t = 0 until seeked.
  await vp(page, "seekExplode", 0);
  await page.getByTestId("toolbar.explode-exploded").click();
  await expect(viewport(page)).toHaveAttribute("data-explode-anim", "paused");
  expect((await anim(page)).target).toBe(1);
  const out = await curveAt(page, CURVE_TS);
  // The shown factor follows the cubic in-out curve exactly at every sample time.
  for (const [i, t] of CURVE_TS.entries()) expect(out[i]!, `exploding t=${t}`).toBeCloseTo(explodeAt(0, 1, t), 12);
  // Eased: monotonic, slow at the start, fast in the middle, symmetric about t = 0.5.
  for (let i = 1; i < out.length; i++) expect(out[i]!).toBeGreaterThan(out[i - 1]!);
  expect(out[1]!).toBeLessThan(0.1);
  // Mean speed over t 0.4..0.6 is several times that over t 0..0.25.
  expect((out[5]! - out[3]!) / 0.2).toBeGreaterThan(4 * ((out[2]! - out[0]!) / 0.25));
  expect(out[2]! + out[6]!).toBeCloseTo(1, 12);
  expect(out[4]!).toBeCloseTo(0.5, 12);
  // Released at t = 1, the tween lands on the clock.
  await vp(page, "seekExplode", null);
  await expect(viewport(page)).toHaveAttribute("data-explode", "1.00");
  await expect(viewport(page)).toHaveAttribute("data-explode-anim", "idle");
  expect((await anim(page)).shown).toBe(1);
  const nose = (await vp<[number, number, number]>(page, "partOffset", "nose"))[0];
  expect(nose).toBeLessThan(-0.1);

  // Assembled eases back down the same curve (1 -> 0).
  await vp(page, "seekExplode", 0);
  await page.getByTestId("toolbar.explode-assembled").click();
  await expect(viewport(page)).toHaveAttribute("data-explode-anim", "paused");
  expect((await anim(page)).target).toBe(0);
  const back = await curveAt(page, CURVE_TS);
  for (const [i, t] of CURVE_TS.entries()) expect(back[i]!, `assembling t=${t}`).toBeCloseTo(explodeAt(1, 0, t), 12);
  for (let i = 1; i < back.length; i++) expect(back[i]!).toBeLessThan(back[i - 1]!);
  // Released mid-flight, it resumes from the pinned time and finishes on the clock.
  await vp(page, "seekExplode", 0.5);
  await frames(page);
  await vp(page, "seekExplode", null);
  await expect(viewport(page)).toHaveAttribute("data-explode", "0.00");
  await expect.poll(async () => (await anim(page)).running, { timeout: 5000 }).toBe(false);
  expect((await anim(page)).shown).toBe(0);
  expect(await vp(page, "partOffset", "nose")).toEqual([0, 0, 0]);
  // The slider still jumps (no tween).
  await page.getByTestId("toolbar.explode").fill("60");
  await expect(viewport(page)).toHaveAttribute("data-explode", "0.60");
  await frames(page);
  const a = await anim(page);
  expect(a.running).toBe(false);
  expect(a.shown).toBeCloseTo(0.6, 9);
});

test("a pinned tween gives deterministic clip frames; parts separate along the axis", async ({ page }) => {
  // Pin the clock before the tween starts: it holds at t = 0 until the clip seeks it.
  await vp(page, "seekExplode", 0);
  await page.getByTestId("toolbar.explode-exploded").click();
  await expect(viewport(page)).toHaveAttribute("data-explode-anim", "paused");
  const ts = [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1];
  const clip: { t: number; shown: number; centres: Record<string, [number, number]>; nose: number }[] = [];
  for (const [i, t] of ts.entries()) {
    await vp(page, "seekExplode", t);
    await frames(page);
    const a = await anim(page);
    expect(a.paused).toBe(true);
    expect(a.shown, `t=${t}`).toBeCloseTo(explodeAt(0, 1, t), 12);
    const centres = await vp<Record<string, [number, number]>>(page, "screenCentres");
    const nose = (await vp<[number, number, number]>(page, "partOffset", "nose"))[0];
    clip.push({ t, shown: a.shown, centres, nose });
    const png = await vp<{ png_base64: string }>(page, "capture", 768, 512);
    saveArtifact("explode", `frame-${String(i).padStart(2, "0")}-t${t.toFixed(3)}.png`, png.png_base64);
  }
  // Determinism: the same t gives the same state.
  await vp(page, "seekExplode", 0.5);
  await frames(page);
  expect((await anim(page)).shown).toBe(clip[4]!.shown);
  expect(await vp(page, "screenCentres")).toEqual(clip[4]!.centres);

  // Motion axis: the nose-to-motor vector keeps the axis direction and grows monotonically;
  // every part's projection on it keeps the assembly order.
  const axis = await vp<[number, number]>(page, "axisOnScreen");
  const first = clip[0]!.centres;
  const last = clip.at(-1)!.centres;
  const span = (c: Record<string, [number, number]>) => [c["motor_casing"]![0] - c["nose"]![0], c["motor_casing"]![1] - c["nose"]![1]] as const;
  const d0 = span(first);
  const d1 = span(last);
  const unit = (v: readonly [number, number]) => {
    const l = Math.hypot(v[0], v[1]);
    return [v[0] / l, v[1] / l] as const;
  };
  const u0 = unit(d0);
  const u1 = unit(d1);
  expect(u0[0] * u1[0] + u0[1] * u1[1], "nose->motor direction is stable").toBeGreaterThan(0.98);
  expect(Math.abs(u1[0] * axis[0] + u1[1] * axis[1]), "separation runs along the on-screen body axis").toBeGreaterThan(0.98);
  // Every frame keeps the parts in view (the camera eases through framings of the in-between layouts).
  const box = (await viewport(page).boundingBox())!;
  for (const f of clip)
    for (const [id, [x, y]] of Object.entries(f.centres)) {
      expect(x, `${id} x at t=${f.t}`).toBeGreaterThan(0);
      expect(x).toBeLessThan(box.width);
      expect(y, `${id} y at t=${f.t}`).toBeGreaterThan(0);
      expect(y).toBeLessThan(box.height);
    }
  // World offsets grow monotonically (the camera eases out as the parts spread, so screen lengths need not).
  let prevNose = 1;
  for (const f of clip) {
    expect(f.nose, `t=${f.t}`).toBeLessThanOrEqual(prevNose + 1e-12);
    prevNose = f.nose;
    const d = span(f.centres);
    const u = unit(d);
    expect(u[0] * u1[0] + u[1] * u1[1], `direction at t=${f.t}`).toBeGreaterThan(0.98);
  }
  expect(Math.hypot(...d1)).toBeGreaterThan(Math.hypot(...d0));
  const ord = (c: Record<string, [number, number]>) =>
    ["nose", "recovery_bay", "airframe", "ebay", "fin_can", "motor_casing"].map((id) => (c[id]![0] - c["nose"]![0]) * u1[0] + (c[id]![1] - c["nose"]![1]) * u1[1]);
  const along = ord(last);
  for (let i = 1; i < along.length; i++) expect(along[i]!, `order at t=1 (${along.join(", ")})`).toBeGreaterThan(along[i - 1]!);

  // Released, the tween finishes on the clock.
  await vp(page, "seekExplode", null);
  await expect(viewport(page)).toHaveAttribute("data-explode-anim", "idle");
  expect((await anim(page)).shown).toBe(1);
});
