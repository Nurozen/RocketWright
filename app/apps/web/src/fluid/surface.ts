// Ported from three.js (MIT) examples/jsm/tsl/utils/Raymarching.js (r186, the box ray setup)
/**
 * The page 06 fluid's reconstructed surface (M5.2, FID2-06): the tank's
 * inside below the free-surface plane fitted over the MLS-MPM particles'
 * top layer (`freeSurface.ts`), ray-marched against its exact distance
 * field (the tank capsule intersected with the plane's half-space) in a box
 * over the tank, and shaded as a glassy translucent teal liquid (`#26555c`
 * family). The liquid is the pooled volume clipped to the tank's inner wall
 * (cylinder and domes), filled to the study's fill fraction, with ONE smooth
 * planar free surface tilted from the fluid state plus at most a gentle,
 * capped, long-wavelength ripple (`freeSurface.ts` `waveAmplitude`,
 * `waveTrains`; R20-06: never the particles' relief, no crests, no fine
 * noise), a bright meniscus line where it meets the wall, Fresnel, a
 * key-light highlight, a studio-gradient reflection, and absorption by the
 * liquid's thickness along the ray. Never raw particles, never a lumpy
 * density isosurface.
 *
 * The ray setup follows three.js (MIT) `examples/jsm/tsl/utils/Raymarching.js`
 * (`RaymarchingBox`'s box hit and object-space ray); see NOTICE.md.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- TSL node graphs are untyped at this level */
import * as TSL from "three/tsl";
import * as THREE from "three/webgpu";
import { waveTrains } from "./freeSurface.ts";
import { axialHalf, type TankShape } from "./tankSdf.ts";

type N = any;

/** TSL builders, untyped: the node graphs here outgrow the published overloads. */
const {
  Break,
  Fn,
  If,
  Loop,
  abs,
  cameraPosition,
  clamp,
  cos,
  cross,
  exp,
  float,
  length,
  max,
  min,
  mix,
  modelWorldMatrix,
  modelWorldMatrixInverse,
  normalize,
  positionGeometry,
  pow,
  select,
  sin,
  smoothstep,
  uniform,
  varying,
  vec2,
  vec3,
  vec4,
} = TSL as N;

/** The liquid colour (concept 06, translucent teal). */
export const FLUID_TEAL = "#26555c";

export interface FluidSurface {
  mesh: THREE.Mesh;
  /** 0..1: fades the liquid (Flow layer emphasis, empty tank). */
  opacity: { value: number };
  /** World-space key-light direction (toward the light). */
  light: { value: THREE.Vector3 };
  /** The free surface: liquid where dot(normal, p) < offset (tank frame). */
  planeNormal: { value: THREE.Vector3 };
  planeOffset: { value: number };
  /** Ripple clock, s. */
  time: { value: number };
  /** Wave amplitude on the free surface (m, tank frame); the stage sets it from the particle state. */
  waveAmp: { value: number };
}

/** How far inside the tank's inner wall the liquid is drawn (m), so the glass reads over it. */
const INSET = 0.0006;

/**
 * A box over the tank (tank frame, metres) whose material ray-marches the
 * liquid. Add it to the tank group (tank frame = the group's frame).
 */
export function fluidSurface(shape: TankShape): FluidSurface {
  const R = Math.max(1e-4, shape.radius - INSET);
  const hl = shape.capsule ? shape.halfLength : Math.max(1e-4, shape.halfLength - INSET);
  const ax = axialHalf(shape);
  const half = vec3(ax + 0.002, R + 0.002, R + 0.002);
  const opacity: N = uniform(1);
  const light: N = uniform(new THREE.Vector3(-0.4, 0.8, 0.45).normalize());
  const planeNormal: N = uniform(new THREE.Vector3(0, 0, 1));
  const planeOffset: N = uniform(0);
  const time: N = uniform(0);
  const waveAmp: N = uniform(0);
  const trains = waveTrains(2 * shape.radius);
  // Steepest slope per unit amplitude: the plane distance is scaled by 1 / sqrt(1 + slope^2) so the trace never overshoots.
  const slopePerA = trains.reduce((acc, w) => acc + w.w * w.k, 0);
  const stepScale: N = float(1).div(waveAmp.mul(slopePerA).pow(2).add(1).sqrt());
  const teal = new THREE.Color(FLUID_TEAL);
  // Saturated, brighter than the legend's FLUID_TEAL: the liquid is drawn over a dark interior and must read as a lit teal volume.
  const deep: N = uniform(teal.clone().lerp(new THREE.Color("#0c5c66"), 0.6));
  const shallow: N = uniform(new THREE.Color("#167f89"));
  const top: N = uniform(new THREE.Color("#2fb3ba"));
  const eps = 1.5e-4;

  /** Inner tank: capsule along X (hemispherical ends) or a capped cylinder. */
  const sdTank = (p: N): N => {
    const rr = length(vec2(p.y, p.z));
    if (shape.capsule) return length(vec2(max(abs(p.x).sub(hl), 0.0), rr)).sub(R);
    const d = vec2(abs(p.x).sub(hl), rr.sub(R));
    return min(max(d.x, d.y), 0.0).add(length(max(d, vec2(0.0))));
  };
  // The surface's lateral frame (tank frame, from the plane normal).
  const e1: N = normalize(cross(select(abs(planeNormal.y).lessThan(0.9), vec3(0, 1, 0), vec3(1, 0, 0)), planeNormal));
  const e2: N = cross(planeNormal, e1);
  const phase = (w: (typeof trains)[number], a: N, b: N): N => a.mul(w.k * w.d[0]).add(b.mul(w.k * w.d[1])).sub(time.mul(w.omega));
  /** Wave height over the plane at lateral (a, b). */
  const height = (a: N, b: N): N => trains.reduce((acc: N, w) => acc.add(sin(phase(w, a, b)).mul(w.w)), float(0)).mul(waveAmp);
  /** Its gradient (d/da, d/db). */
  const grad = (a: N, b: N): N => trains.reduce((acc: N, w) => acc.add(vec2(w.k * w.d[0], w.k * w.d[1]).mul(cos(phase(w, a, b)).mul(w.w))), vec2(0, 0)).mul(waveAmp);
  const sdPlane = (p: N): N => p.dot(planeNormal).sub(planeOffset).sub(height(p.dot(e1), p.dot(e2))).mul(stepScale);
  const sdLiquid = (p: N): N => max(sdTank(p), sdPlane(p));

  const shade = (Fn as N)(() => {
    const origin = varying(vec3(modelWorldMatrixInverse.mul(vec4(cameraPosition, 1.0))));
    const toFrag = varying(positionGeometry.sub(origin));
    const dir = normalize(toFrag).toVar("dir");
    // Ray / box [-half, half].
    const inv = dir.reciprocal();
    const t0s = half.negate().sub(origin).mul(inv);
    const t1s = half.sub(origin).mul(inv);
    const tmin = min(t0s, t1s);
    const tmax = max(t0s, t1s);
    const bounds = vec2(max(max(tmin.x, max(tmin.y, tmin.z)), 0.0), min(tmax.x, min(tmax.y, tmax.z))).toVar("bounds");
    bounds.x.greaterThan(bounds.y).discard();
    // Sphere trace in from the box entry (the liquid is convex: one entry, one exit).
    const t = bounds.x.toVar("t");
    const hit = float(0).toVar("hit");
    Loop(96, () => {
      const d = sdLiquid(origin.add(dir.mul(t)));
      If(d.lessThan(eps), () => {
        hit.assign(1);
        Break();
      });
      t.addAssign(d);
      If(t.greaterThan(bounds.y), () => {
        Break();
      });
    });
    hit.lessThan(0.5).discard();
    // And back in from the box exit: the far side, for the thickness.
    const tb = bounds.y.toVar("tb");
    Loop(64, () => {
      const d = sdLiquid(origin.add(dir.mul(tb)));
      If(d.lessThan(eps), () => {
        Break();
      });
      tb.subAssign(d);
      If(tb.lessThan(t), () => {
        Break();
      });
    });
    const p = origin.add(dir.mul(t)).toVar("p");
    const dT = sdTank(p).toVar("dT");
    const dP = sdPlane(p).toVar("dP");
    const onTop = dP.greaterThan(dT);
    // Wall normal from the tank's distance gradient (tank frame).
    const k = float(1e-4);
    const gWall = normalize(
      vec3(
        sdTank(p.add(vec3(k, 0, 0))).sub(sdTank(p.sub(vec3(k, 0, 0)))),
        sdTank(p.add(vec3(0, k, 0))).sub(sdTank(p.sub(vec3(0, k, 0)))),
        sdTank(p.add(vec3(0, 0, k))).sub(sdTank(p.sub(vec3(0, 0, k)))),
      ),
    );
    // The free surface: the plane's normal tilted by the gentle ripple's gradient (no fine noise, no crests).
    const a = p.dot(e1);
    const b = p.dot(e2);
    const gr = grad(a, b);
    const nLocal = select(onTop, normalize(planeNormal.sub(e1.mul(gr.x)).sub(e2.mul(gr.y))), gWall);
    const n = normalize(modelWorldMatrix.mul(vec4(nLocal, 0.0)).xyz).toVar("n");
    const pWorld = modelWorldMatrix.mul(vec4(p, 1.0)).xyz;
    const v = normalize(cameraPosition.sub(pWorld)).toVar("v");
    const worldScale = modelWorldMatrix.mul(vec4(dir, 0.0)).xyz.length();
    const thickness = max(tb.sub(t), 0.0).mul(worldScale);
    // The meniscus: where the surface meets the wall (both distances near zero): a bright, thin glassy line.
    const edgeDist = min(dT, dP).negate();
    const meniscus = float(1).sub(smoothstep(0.0, 0.0028, edgeDist));
    const ndv = clamp(n.dot(v), 0.0, 1.0);
    const fresnel = float(0.04).add(float(0.96).mul(pow(float(1).sub(ndv), 5.0)));
    const h = normalize(light.add(v));
    const spec = pow(max(n.dot(h), 0.0), 140.0).mul(select(onTop, float(1.6), float(0.9)));
    const diffuse = max(n.dot(light), 0.0).mul(0.35).add(0.65);
    const absorb = float(1).sub(exp(thickness.mul(-18.0)));
    const body = mix(shallow, deep, absorb).mul(diffuse);
    const r = v.negate().reflect(n);
    const sky = mix(vec3(0.04, 0.12, 0.13), vec3(0.62, 0.9, 0.92), clamp(r.y.mul(0.5).add(0.5), 0.0, 1.0));
    // The top is one glassy teal sheet (lighter than the body, a studio reflection across it); the body is deep teal.
    const surfaceTint = select(onTop, mix(body, top, 0.45), body);
    const rgb = mix(surfaceTint, sky, fresnel.mul(select(onTop, float(0.35), float(0.12))))
      .add(spec)
      .add(vec3(0.75, 0.97, 0.98).mul(meniscus.mul(0.75)));
    const alpha = clamp(float(0.86).add(absorb.mul(0.1)).add(fresnel.mul(0.1)).add(select(onTop, float(0.04), float(0))).add(spec).add(meniscus.mul(0.3)), 0.0, 0.97).mul(opacity);
    return vec4(rgb, alpha);
  })();

  const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.FrontSide });
  mat.colorNode = shade;
  mat.name = "fluidSurface";
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(2 * (ax + 0.002), 2 * (R + 0.002), 2 * (R + 0.002)), mat);
  mesh.name = "fluid.surface";
  mesh.frustumCulled = false;
  return { mesh, opacity, light, planeNormal, planeOffset, time, waveAmp };
}
