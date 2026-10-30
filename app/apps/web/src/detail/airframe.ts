/**
 * Airframe joints that read at page 01 scale (BC5 fidelity): the nose cone's
 * shoulder as a machined lip, coupler lips standing proud of the fore end of
 * tubes that slip onto the part ahead, and a machined motor retainer closing
 * the tail of a motor-mount tube. Dimensions derive from the component (od,
 * id, shoulder, attach, motor mount child); visual tier only (I13).
 */
import * as THREE from "three/webgpu";
import { PRESET_LOOKS } from "../viewport/materials.ts";
import { revolve, tubeProfile } from "./bevel.ts";
import { dim } from "./dims.ts";
import { bevelledTubeDetail } from "./hardware.ts";
import type { DetailContext, DetailResult, EvalComponent } from "./types.ts";

const TUBE_KINDS = new Set(["body_tube", "nose_cone", "transition"]);

interface Shoulder {
  length: number;
  od: number;
  thickness: number;
}

function shoulderOf(c: EvalComponent): Shoulder | null {
  const s = (c.shape as unknown as { shoulder?: Partial<Shoulder> | null }).shoulder;
  if (!s || !(Number(s.length) > 0) || !(Number(s.od) > 0)) return null;
  return { length: Number(s.length), od: Number(s.od), thickness: Number(s.thickness) || 0.001 };
}

/**
 * Nose cone shoulder: a satin-machined sleeve over the rw-geom shoulder (just
 * proud of it, below the body OD), with a chamfered aft edge and a seating
 * step at the base, so the shoulder reads as its own lip. The cone keeps its
 * rw-geom mesh.
 */
export function noseShoulderDetail(ctx: DetailContext): DetailResult | null {
  const c = ctx.component;
  const sh = shoulderOf(c);
  const od = dim(c, "od");
  if (!sh || !(od > 0)) return null;
  const ro = Math.min(sh.od / 2 + 0.0003, od / 2 - 0.0002);
  const ri = Math.max(0.5 * ro, sh.od / 2 - sh.thickness - 0.0002);
  const x0 = c.x_aft - 0.0004;
  const x1 = c.x_aft + sh.length;
  const prof = tubeProfile({ x0, x1, ro, ri, bevel: Math.min(0.4 * (ro - ri), 0.0008), grooves: [0.18], grooveDepth: 0.00025, grooveWidth: 0.0003, steps: 3 });
  const sleeve = new THREE.Mesh(revolve(prof.points, { segments: ctx.segments, closed: true }), ctx.materials.finish("machined"));
  sleeve.name = "nose-shoulder";
  const group = new THREE.Group();
  group.add(sleeve);
  return { group, replacesBase: false, outline: [sleeve] };
}

/** The part a tube slips onto at its fore end (`attach.to = "<id>.aft"`, attached at its fore), if it is an airframe tube. */
export function foreHost(c: EvalComponent, lookup: (id: string) => EvalComponent | undefined): EvalComponent | null {
  const a = c.attach;
  if (!a || (a.at ?? "fore") !== "fore") return null;
  const m = /^([^.]+)\.aft$/.exec(a.to);
  const host = m ? lookup(m[1]!) : undefined;
  return host && TUBE_KINDS.has(host.shape.type) ? host : null;
}

/** A motor-mount inner tube carried by `c` (its child with `motor_mount`), if any. */
export function motorMountOf(c: EvalComponent, lookup: (id: string) => EvalComponent | undefined): EvalComponent | null {
  for (const id of c.children) {
    const k = lookup(id);
    if (k && k.shape.type === "inner_tube" && (k.shape as unknown as { motor_mount?: boolean }).motor_mount === true) return k;
  }
  return null;
}

/**
 * Airframe body tube: the bevelled shell and liner (`bevelledTubeDetail`),
 * plus a coupler lip proud of the fore end when the tube slips onto the part
 * ahead, and a machined motor retainer at the tail when it carries the motor
 * mount (an aft closure plate with a raised, grooved retainer collar around
 * the motor bore).
 */
export function airframeTubeDetail(ctx: DetailContext): DetailResult | null {
  const base = bevelledTubeDetail(ctx);
  if (!base) return null;
  const c = ctx.component;
  const ro = dim(c, "od") / 2;
  const ri = dim(c, "id") / 2;
  const seg = ctx.segments;
  const group = base.group;
  if (foreHost(c, ctx.lookup)) {
    const lipLen = Math.min(0.3 * ro, 0.25 * (c.x_aft - c.x_fore));
    const lo = ri - 0.00015;
    const li = lo - Math.max(0.0008, 0.035 * ro);
    const prof = tubeProfile({ x0: c.x_fore - lipLen, x1: c.x_fore + 0.5 * lipLen, ro: lo, ri: li, bevel: 0.35 * (lo - li), steps: 2 });
    const lip = new THREE.Mesh(revolve(prof.points, { segments: seg, closed: true }), ctx.materials.look(PRESET_LOOKS.composite_gray));
    lip.name = "tube-coupler-lip";
    group.add(lip);
  }
  const mount = motorMountOf(c, ctx.lookup);
  if (mount) {
    const mo = dim(mount, "od") / 2;
    if (mo > 0 && mo < ri) {
      const plateT = Math.min(0.004, 0.1 * ro);
      const bore = mo + 0.0004;
      const plate = tubeProfile({ x0: c.x_aft - plateT, x1: c.x_aft, ro: ri - 0.0001, ri: bore, bevel: 0.3 * plateT, steps: 2 });
      const collarR = Math.min(ri - 0.002, mo + Math.max(0.004, 0.45 * (ri - mo)));
      const collarLen = Math.min(0.012, 0.35 * ro);
      const collar = tubeProfile({ x0: c.x_aft - 0.5 * plateT, x1: c.x_aft + collarLen, ro: collarR, ri: bore, bevel: 0.0008, grooves: [0.35, 0.6, 0.85], grooveDepth: 0.0004, grooveWidth: 0.00035, steps: 3 });
      const m = ctx.materials.finish("machined");
      const plateMesh = new THREE.Mesh(revolve(plate.points, { segments: seg, closed: true }), ctx.materials.finish("anodized_dark"));
      plateMesh.name = "tube-retainer-plate";
      const collarMesh = new THREE.Mesh(revolve(collar.points, { segments: seg, closed: true }), m);
      collarMesh.name = "tube-motor-retainer";
      group.add(plateMesh, collarMesh);
    }
  }
  return { group, outline: base.outline ?? [] };
}
