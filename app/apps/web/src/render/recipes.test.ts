/** RL3 render recipes (no GPU): check colours, framing, and the body-frame camera. */
import { describe, expect, it } from "vitest";
import { bodyToWorld, cameraBasis, VIEW_IDS, viewPose, type Vec3 } from "../viewport/views.ts";
import { bodyCamera, CHECK_COLORS, checkColor, componentOfPath, frameBox, FRAME_MARGIN, isRenderView, PBR_FOV_DEG, worldToBody, worstSeverity, type Box } from "./recipes.ts";

const diag = (path: string | null, severity: "error" | "warning" | "info") => ({ code: "RW-E100", severity, path, message: "m" });

describe("check colours", () => {
  it("maps diagnostic paths to components", () => {
    expect(componentOfPath("/c/fins/span")).toBe("fins");
    expect(componentOfPath("/c/nose")).toBe("nose");
    expect(componentOfPath("/params/x")).toBeNull();
    expect(componentOfPath(null)).toBeNull();
  });

  it("tints each part by its worst warning or error", () => {
    const worst = worstSeverity({
      diagnostics: [diag("/c/fins/span", "warning"), diag("/c/fins/root", "error"), diag("/c/body/od", "warning"), diag("/c/nose", "info"), diag(null, "error")],
    });
    expect(Object.fromEntries(worst)).toEqual({ fins: "error", body: "warning" });
    expect(checkColor("fins", worst)).toBe(CHECK_COLORS.error);
    expect(checkColor("body", worst)).toBe(CHECK_COLORS.warning);
    expect(checkColor("nose", worst)).toBe(CHECK_COLORS.ok);
    expect(worstSeverity(null).size).toBe(0);
  });
});

describe("framing", () => {
  const box: Box = { min: [0, -0.03, -0.03], max: [0.76, 0.03, 0.03] };
  const centre: Vec3 = [0.38, 0, 0];

  it("worldToBody inverts the loader's body -> Y-up rotation", () => {
    for (const v of [[1, 2, 3], [-0.5, 0.25, 4]] as Vec3[]) expect(worldToBody(bodyToWorld(v))).toEqual(v);
  });

  it("fits every box corner inside the orthographic frustum, tightly", () => {
    for (const view of VIEW_IDS) {
      const aspect = 1.5;
      const f = frameBox(view, box, aspect, true);
      expect(f.orthographic).toBe(true);
      expect(f.target).toEqual(centre);
      const half = (f.orthoHeight ?? 0) / 2;
      const b = cameraBasis(viewPose(view));
      let maxX = 0;
      let maxY = 0;
      for (const x of [box.min[0], box.max[0]])
        for (const y of [box.min[1], box.max[1]])
          for (const z of [box.min[2], box.max[2]]) {
            const d = [x - centre[0], y - centre[1], z - centre[2]] as const;
            const sx = Math.abs(d[0] * b.right[0] + d[1] * b.right[1] + d[2] * b.right[2]);
            const sy = Math.abs(d[0] * b.up[0] + d[1] * b.up[1] + d[2] * b.up[2]);
            const depth = d[0] * b.back[0] + d[1] * b.back[1] + d[2] * b.back[2];
            const dist = Math.hypot(f.position[0] - centre[0], f.position[1] - centre[1], f.position[2] - centre[2]);
            expect(sx).toBeLessThanOrEqual(half * aspect + 1e-9);
            expect(sy).toBeLessThanOrEqual(half + 1e-9);
            expect(dist - depth).toBeGreaterThan(f.near);
            expect(dist - depth).toBeLessThan(f.far);
            maxX = Math.max(maxX, sx);
            maxY = Math.max(maxY, sy);
          }
      // One axis touches the margin.
      expect(Math.max(maxX / aspect, maxY) * FRAME_MARGIN).toBeCloseTo(half, 9);
    }
  });

  it("perspective framing uses the viewport field of view", () => {
    const f = frameBox("iso", box, 1.5, false);
    expect(f.orthographic).toBe(false);
    expect(f.fovDeg).toBe(PBR_FOV_DEG);
    expect(f.orthoHeight).toBeUndefined();
  });

  it("reports the camera in the body frame (+X aft, +Z up)", () => {
    const side = bodyCamera(frameBox("side", box, 1.5, true));
    // Side: the camera sits on world +Z, which is body -Y, with body +Z up.
    expect(side.position[1]).toBeLessThan(0);
    expect(side.up).toEqual([0, 0, 1]);
    expect(side.target).toEqual([0.38, 0, 0]);
    expect(side.orthographic).toBe(true);
    expect(side.ortho_height).toBeGreaterThan(0);
    expect("fov_deg" in side).toBe(false);
    const front = bodyCamera(frameBox("front", box, 1.5, false));
    expect(front.position[0]).toBeLessThan(0);
    expect(front.fov_deg).toBe(PBR_FOV_DEG);
  });

  it("knows the renderer's views", () => {
    for (const v of VIEW_IDS) expect(isRenderView(v)).toBe(true);
    expect(isRenderView("section")).toBe(false);
  });
});
