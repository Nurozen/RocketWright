/**
 * M3.3 section cuts on the live page 01 (web bundle, app server, seeded
 * research vehicle):
 * - Live: the Section switch enables the clipping group and the stencil caps
 *   (two writers per base mesh, one hatched cap quad); on a GPU the cap draws
 *   real pixels on the final output. The capture is left in
 *   `.playwright/m3/section/`.
 * - Stills: `manifold-3d` cuts each part's engineering mesh; the airframe
 *   tube keeps exactly half its volume, and that volume equals the analytic
 *   64-gon tube from `rw check` dims (the viewport's radial segments).
 */
import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { MESH_OPTIONS } from "../apps/web/src/viewport/glb-source.ts";
import { chip, frames, openAssembly, PROJECT, saveArtifact, viewport, vp } from "./viewport-helpers.ts";

interface Dims {
  component: string;
  length: number;
  od?: number | null;
  id?: number | null;
}

function rwDims(): Dims[] {
  const bin = process.env["RW_SIDECAR_BIN"] || "rocketwright";
  let out: string;
  try {
    out = execFileSync(bin, ["-C", PROJECT, "--json", "check"], { encoding: "utf8" });
  } catch (e) {
    out = (e as { stdout?: string }).stdout ?? "";
  }
  return (JSON.parse(out) as { dims: { components: Dims[] } }).dims.components;
}

/** Volume of a tube between two regular n-gons inscribed in the radii (the mesh rw-geom emits). */
const polygonTube = (od: number, id: number, length: number, n: number) => (n / 2) * Math.sin((2 * Math.PI) / n) * ((od / 2) ** 2 - (id / 2) ** 2) * length;

test.beforeEach(async ({ page }) => {
  await openAssembly(page);
});

test("the Section switch shows live stencil caps on the cut", async ({ page }) => {
  expect(await vp(page, "sectionCaps")).toMatchObject({ enabled: false, cap: true });
  await page.getByTestId("toolbar.section").click();
  await expect(viewport(page)).toHaveAttribute("data-section", "true");
  const caps = await vp<{ writers: number; activeWriters: number; cap: boolean; enabled: boolean }>(page, "sectionCaps");
  expect(caps.enabled).toBe(true);
  expect(caps.cap).toBe(true);
  const parts = (await vp<string[]>(page, "visibleParts")).length;
  expect(caps.writers).toBeGreaterThanOrEqual(2 * parts);
  expect(caps.activeWriters).toBe(caps.writers);
  test.skip((await vp<string>(page, "backend")) === "none", "cap pixels need a renderer");
  // The cap is on the plane facing the Iso camera: it draws real pixels, in Iso and in Side.
  for (const view of ["Iso", "Side"]) {
    await chip(page, view).click();
    await expect(viewport(page)).toHaveAttribute("data-view", view.toLowerCase());
    await frames(page, 3);
    const png = await vp<{ png_base64: string }>(page, "capture");
    saveArtifact("section", `live-${view.toLowerCase()}.png`, png.png_base64);
    const px = await vp<number>(page, "capPixels");
    expect(px, `${view} cap pixels`).toBeGreaterThan(400);
  }
  // Hidden parts take their writers with them.
  await page.locator('[data-testid="rail.nav-row"][data-part="airframe"] [data-testid="tree.eye"]').click();
  await expect.poll(async () => (await vp<{ activeWriters: number }>(page, "sectionCaps")).activeWriters).toBeLessThan(caps.writers);
  await page.getByTestId("toolbar.section").click();
  await expect(viewport(page)).toHaveAttribute("data-section", "false");
  expect(await vp(page, "sectionCaps")).toMatchObject({ enabled: false });
});

test("still cuts (manifold-3d) keep half of each axisymmetric part; the airframe matches the analytic tube", async ({ page }) => {
  const cut = await vp<Record<string, { method: string[]; bodyVolume: number; volume: number; capArea: number }>>(page, "sectionStill");
  const air = cut["airframe"]!;
  expect(air.method).toContain("manifold");
  const d = rwDims().find((c) => c.component === "airframe")!;
  const analytic = polygonTube(d.od!, d.id!, d.length, MESH_OPTIONS.radial_segments);
  expect(Math.abs(air.bodyVolume - analytic) / analytic, `airframe ${air.bodyVolume} vs ${analytic} m^3`).toBeLessThan(0.005);
  expect(Math.abs(air.volume - analytic / 2) / (analytic / 2)).toBeLessThan(0.005);
  // The cap of a tube cut through its axis: two wall strips, (od - id) x length.
  expect(Math.abs(air.capArea - (d.od! - d.id!) * d.length) / ((d.od! - d.id!) * d.length)).toBeLessThan(0.01);
  // Most parts are closed solids; every closed one keeps half (the plane runs through the axis).
  const closed = Object.entries(cut).filter(([, r]) => r.bodyVolume > 0 && r.method.every((m) => m === "manifold"));
  expect(closed.length).toBeGreaterThanOrEqual(5);
  for (const [id, r] of closed) if (!["lug", "fins"].includes(id)) expect(r.volume / r.bodyVolume, id).toBeCloseTo(0.5, 2);
});
