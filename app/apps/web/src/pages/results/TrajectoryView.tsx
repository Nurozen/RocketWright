/**
 * Trajectory view inset (C §4.4): the runs' 3D flight paths over a flat ground
 * grid, three r186 WebGPU (`three/webgpu` only; WebGL2 backend when WebGPU is
 * unavailable). Renders on demand; dragging orbits the camera about the
 * vertical. An SVG axis gizmo (ENU X east, Y north, Z up) and a DOM legend
 * sit over the canvas.
 *
 * Studio stage (FID-03-05, as page 01): the camera is fitted tightly to the
 * paths and the pad (`cameraFor` with `framePoints`). The launch pad (R19-04)
 * is a base plate with the sim's rail (length relative to the rocket, rod
 * angle and azimuth) and the rocket on it in the model's looks (PBR presets,
 * lit by the studio key from the camera side), on a soft contact shadow
 * (`StudioFloor` plus a broad shade). Each path starts at the pad's
 * departure point above the rail top (`startAtPad`), so no line crosses the
 * enlarged rocket. The ground carries a light pool round the pad and the
 * inset a vignette (CSS).
 */
import { useEffect, useRef, useState } from "react";
import * as THREE from "three/webgpu";
import { PRESET_LOOKS } from "../../viewport/materials.ts";
import { loadStudioRig, STUDIO_RIG } from "../../viewport/lighting.ts";
import { physicalMaterial } from "../../viewport/presets.ts";
import { StudioFloor } from "../../viewport/productStage.ts";
import { STAGE_LOOK, type StageLook } from "../../viewport/stage.ts";
import {
  cameraFor,
  framePoints,
  frameScene,
  gizmoAxes,
  padBounds,
  padModelOf,
  padRocket,
  startAtPad,
  type LaunchRail,
  type PadModel,
  type PadRocket,
  type Vec3,
} from "./trajectory.ts";

export interface TrajectoryPath {
  id: string;
  label: string;
  color: string;
  points: readonly Vec3[];
}

/** The launch pad the paths start from: the sim's rail and the rocket's model (null: a generic white rocket on a vertical rail). */
export interface TrajectoryPad {
  rail: LaunchRail | null;
  model: PadModel;
}

export interface TrajectoryViewProps {
  paths: readonly TrajectoryPath[];
  pad?: TrajectoryPad | null;
}

type Gizmo = ReturnType<typeof gizmoAxes>;

const FOV = 32;
/**
 * The studio rig in the inset (no tone mapping here). Three's physical lights
 * put a white Lambert surface at albedo x intensity / pi, so the key is raised
 * by about pi over the rig's (which page 01 lifts through its environment and
 * tone mapping) for the body to read white; the environment and rim stay near
 * the rig's.
 */
const INSET_KEY = 2.2;
const INSET_ENV = 0.9;
const INSET_RIM = 0.8;
/** Key light direction (world, from the pad): above and to the left of the inset camera (`INSET_DIR`). */
const INSET_KEY_DIR: Vec3 = [-0.25, 0.85, 1];
/** The contact shadow at inset scale: darker than the product shots, so it reads under a small subject. */
const INSET_SHADOW: StageLook = { ...STAGE_LOOK, contactOpacity: 0.8, broadOpacity: 0.66 };

function cssVar(el: Element, name: string, fallback: string): string {
  return getComputedStyle(el).getPropertyValue(name).trim() || fallback;
}

/**
 * The ground's light pool: a radial lift (`centre`) round the pad over the
 * panel colour (`ground`), falling to the backdrop (`edge`) at the rim, so
 * the far ground fades into the inset's vignette instead of ending at a
 * hard edge.
 */
function poolTexture(centre: string, ground: string, edge: string): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d")!;
  const rg = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  rg.addColorStop(0, centre);
  rg.addColorStop(0.18, ground);
  rg.addColorStop(0.55, ground);
  rg.addColorStop(1, edge);
  g.fillStyle = rg;
  g.fillRect(0, 0, 256, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** The broad shade's edge, in plate widths. */
const AO_SPAN = 3.4;

/** A soft black radial shade (alpha falling from the centre to nothing at the rim). */
function shadeTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  const rg = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  rg.addColorStop(0, "rgba(0,0,0,0.75)");
  rg.addColorStop(0.3, "rgba(0,0,0,0.52)");
  rg.addColorStop(0.65, "rgba(0,0,0,0.18)");
  rg.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = rg;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * Builds the pad into `group`: the base plate, the rail (square section, its
 * foot on the plate, leaning along `pad.axis`), and the rocket on it (body,
 * ogive nose, `pad.fins` fins at the base) in the model's looks.
 */
function buildPad(group: THREE.Group, pad: PadRocket, look: PadModel, disposables: { dispose(): void }[]): void {
  const bodyMat = physicalMaterial(look.body);
  const noseMat = physicalMaterial(look.nose);
  const finMat = physicalMaterial(look.fin);
  // The rail: satin aluminium, light enough to read against the dark ground (polished metal mirrors the dark rig).
  const steel = physicalMaterial({ ...PRESET_LOOKS.aluminium_brushed, color: "#d2d6da", metalness: 0.35, roughness: 0.38, anisotropy: 0 });
  const plateMat = physicalMaterial({ ...PRESET_LOOKS.composite_gray, color: "#9aa0a5", metalness: 0.5, roughness: 0.42 });
  disposables.push(bodyMat, noseMat, finMat, steel, plateMat);
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, parent: THREE.Object3D) => {
    const m = new THREE.Mesh(geo, mat);
    parent.add(m);
    disposables.push(geo);
    return m;
  };
  // Base plate on the ground.
  add(new THREE.BoxGeometry(pad.plate, pad.plateThickness, pad.plate).translate(0, pad.plateThickness / 2, 0), plateMat, group);
  // Rail and rocket lean together about the plate's top centre.
  const lean = new THREE.Group();
  lean.position.set(0, pad.plateThickness, 0);
  lean.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(...pad.axis));
  group.add(lean);
  const [ox, oy, oz] = pad.railOffset;
  const local = new THREE.Vector3(ox, oy, oz).applyQuaternion(lean.quaternion.clone().invert());
  const rail = add(new THREE.BoxGeometry(pad.railWidth, pad.rail, pad.railWidth).translate(0, pad.rail / 2, 0), steel, lean);
  rail.position.set(local.x, 0, local.z);
  // The rail's foot: a short post block on the plate.
  const foot = add(new THREE.BoxGeometry(pad.railWidth * 2.2, pad.height * 0.06, pad.railWidth * 2.2).translate(0, pad.height * 0.03, 0), steel, lean);
  foot.position.set(local.x, 0, local.z);
  // Rocket: body, ogive nose, fins; its base just above the plate (on the rail buttons).
  const rocket = new THREE.Group();
  rocket.position.y = pad.height * 0.02;
  lean.add(rocket);
  add(new THREE.CylinderGeometry(pad.radius, pad.radius, pad.body, 40).translate(0, pad.body / 2, 0), bodyMat, rocket);
  const ogive = Array.from({ length: 17 }, (_, i) => {
    const t = i / 16;
    return new THREE.Vector2(pad.radius * Math.sqrt(Math.max(0, 1 - t * t)), pad.body + pad.nose * t);
  });
  add(new THREE.LatheGeometry(ogive, 40), noseMat, rocket);
  // Fins: swept trapezoids (root chord at the base, tip chord half), turned to face away from the rail.
  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  shape.lineTo(pad.fin, pad.finChord * 0.15);
  shape.lineTo(pad.fin, pad.finChord * 0.6);
  shape.lineTo(0, pad.finChord);
  shape.closePath();
  const finGeo = new THREE.ExtrudeGeometry(shape, { depth: pad.radius * 0.18, bevelEnabled: false }).translate(pad.radius * 0.9, 0, -pad.radius * 0.09);
  disposables.push(finGeo);
  const railAz = Math.atan2(-local.z, local.x);
  for (let k = 0; k < pad.fins; k++) {
    const fin = new THREE.Mesh(finGeo, finMat);
    fin.rotation.y = railAz + Math.PI / pad.fins + (k * 2 * Math.PI) / pad.fins;
    rocket.add(fin);
  }
}

export function TrajectoryView({ paths, pad: padSpec = null }: TrajectoryViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [gizmo, setGizmo] = useState<Gizmo | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;
    let disposed = false;
    host.dataset.ready = "false";
    const renderer = new THREE.WebGPURenderer({ canvas, antialias: true, alpha: false });
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 1e6);
    const disposables: { dispose(): void }[] = [];
    let yaw = 0;
    let base: { position: Vec3; target: Vec3 } | null = null;

    const place = () => {
      if (!base) return;
      const [tx, ty, tz] = base.target;
      const dx = base.position[0] - tx;
      const dz = base.position[2] - tz;
      const c = Math.cos(yaw);
      const s = Math.sin(yaw);
      camera.position.set(tx + dx * c - dz * s, base.position[1], tz + dx * s + dz * c);
      camera.lookAt(tx, ty, tz);
      camera.updateMatrixWorld(true);
      setGizmo(gizmoAxes(camera.matrixWorldInverse.elements));
    };
    const draw = () => {
      if (!disposed && base) renderer.render(scene, camera);
    };
    const resize = () => {
      const w = Math.max(1, canvas.clientWidth);
      const h = Math.max(1, canvas.clientHeight);
      renderer.setPixelRatio(window.devicePixelRatio);
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };

    (async () => {
      await renderer.init();
      if (disposed) return;
      const bg = new THREE.Color(cssVar(host, "--rw-bg-viewport-bottom", "#171c20"));
      const line = new THREE.Color(cssVar(host, "--rw-line", "#2a3034"));
      const lineStrong = new THREE.Color(cssVar(host, "--rw-text-secondary", "#8e989c")).lerp(line, 0.55);
      scene.background = bg;

      const frame = frameScene(paths.map((p) => [...p.points]));
      const look = padSpec?.model ?? padModelOf(null);
      const apexes = paths.filter((p) => p.points.length >= 2).map((p) => Math.max(...p.points.map((q) => q[1])));
      const minApex = apexes.length > 0 ? Math.min(...apexes) : undefined;
      // Ground with a light pool round the paths (the studio's lift of the floor; edges fall to the backdrop).
      const panel = new THREE.Color(cssVar(host, "--rw-panel", "#25292c"));
      const lift = panel.clone().lerp(new THREE.Color(cssVar(host, "--rw-text-secondary", "#8e989c")), 0.1);
      const groundTex = poolTexture(`#${lift.getHexString()}`, `#${panel.getHexString()}`, cssVar(host, "--rw-bg-viewport-bottom", "#171c20"));
      const groundMat = new THREE.MeshBasicMaterial({ map: groundTex });
      const ground = new THREE.Mesh(new THREE.PlaneGeometry(frame.ground, frame.ground).rotateX(-Math.PI / 2), groundMat);
      ground.position.y = -frame.ground * 1e-4;
      const grid = new THREE.GridHelper(frame.ground, Math.round(frame.ground / frame.cell), lineStrong, line);
      ground.renderOrder = -3;
      grid.renderOrder = -2;
      scene.add(ground, grid);
      disposables.push(ground.geometry, groundMat, groundTex, grid.geometry, grid.material as THREE.Material);

      // Pad (visual tier, enlarged to read at inset scale): a base plate, the sim's launch rail at its
      // length and angle, and the rocket standing on it in the model's looks (PBR presets).
      const padGroup = new THREE.Group();
      const pad = padRocket(frame.apex, frame.ground, { rail: padSpec?.rail ?? null, model: look, minApex });
      buildPad(padGroup, pad, look, disposables);
      scene.add(padGroup);
      // Studio light on the pad: the rig environment, the key from the camera's upper left (so the
      // upright body is lit, not grazed from above), and the cool rim behind. The inset renders without
      // tone mapping (the ground, grid, and series colours stay exact), so the key is set for a white
      // composite that reads white with its highlights below clipping.
      scene.add(new THREE.HemisphereLight(0xe4ecf5, 0x1a1d21, STUDIO_RIG.hemisphere));
      const key = new THREE.DirectionalLight(0xfff8f0, STUDIO_RIG.key * INSET_KEY);
      key.position.set(...INSET_KEY_DIR).multiplyScalar(pad.height * 3);
      const rim = new THREE.DirectionalLight(0xa9c8ff, STUDIO_RIG.rim * INSET_RIM);
      rim.position.set(-3 * pad.height, 1.5 * pad.height, -2 * pad.height);
      scene.add(key, rim);
      try {
        const env = await loadStudioRig();
        if (disposed) return;
        scene.environment = env;
        scene.environmentIntensity = STUDIO_RIG.envIntensity * INSET_ENV;
        disposables.push(env);
      } catch {
        // The lights alone still shade it.
      }
      // Contact shadow: the shared studio floor (a stronger look at inset scale), baked from the pad.
      // Drawn right after the ground and grid and before everything standing on them (render order),
      // without a depth test: at the inset's grazing distances the ground's depth would hide it.
      const floor = new StudioFloor(INSET_SHADOW);
      floor.mesh.renderOrder = -1;
      (floor.mesh.material as THREE.Material).depthTest = false;
      padGroup.updateMatrixWorld(true);
      floor.place(padGroup, pad.plateThickness * 0.5, pad.plate * 0.45);
      // Under it, a broad soft shade (ambient occlusion round the pad, leaning with the key's shadow
      // toward the camera), so the pad reads as standing on the ground at inset scale.
      const aoTex = shadeTexture();
      // Blended in the opaque pass (as the studio floor), so the render order puts it under the pad.
      const aoMat = new THREE.MeshBasicMaterial({ map: aoTex, transparent: false, depthTest: false, depthWrite: false });
      aoMat.blending = THREE.CustomBlending;
      aoMat.blendSrc = THREE.SrcAlphaFactor;
      aoMat.blendDst = THREE.OneMinusSrcAlphaFactor;
      aoMat.blendSrcAlpha = THREE.OneFactor;
      aoMat.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
      const ao = new THREE.Mesh(new THREE.PlaneGeometry(pad.plate * AO_SPAN, pad.plate * AO_SPAN).rotateX(-Math.PI / 2), aoMat);
      ao.position.set(0, pad.plateThickness * 0.25, pad.plate * 0.25);
      ao.renderOrder = -1.5;
      scene.add(ao);
      disposables.push(ao.geometry, aoMat, aoTex);
      scene.add(floor.mesh);
      disposables.push(floor);
      const bake = floor.bake();
      host.dataset.shadow = bake !== null ? "true" : "false";
      host.dataset.shadowPeak = bake !== null ? bake.shadow.reduce((m, v) => Math.max(m, v), 0).toFixed(2) : "0";

      // Flight paths start at the pad's departure point (above the rail top and the nose), depth-tested
      // against the pad, so no line runs over the rocket.
      const tubeR = Math.max(frame.radius * 0.01, 0.05);
      const drawn = paths.map((p) => ({ ...p, points: startAtPad(p.points, pad.departure) }));
      for (const p of drawn) {
        if (p.points.length < 2) continue;
        const curve = new THREE.CatmullRomCurve3(p.points.map(([x, y, z]) => new THREE.Vector3(x, y, z)), false, "centripetal");
        const geo = new THREE.TubeGeometry(curve, Math.min(800, p.points.length * 3), tubeR, 8, false);
        const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(p.color) });
        scene.add(new THREE.Mesh(geo, mat));
        disposables.push(geo, mat);
        // Landing marker: a small ring on the ground.
        const end = p.points.at(-1)!;
        const ring = new THREE.Mesh(new THREE.RingGeometry(tubeR * 3, tubeR * 4.5, 24).rotateX(-Math.PI / 2), mat);
        ring.position.set(end[0], frame.ground * 1e-4, end[2]);
        scene.add(ring);
        disposables.push(ring.geometry);
      }

      resize();
      base = cameraFor(frame, FOV, camera.aspect, framePoints(drawn.map((p) => p.points), padBounds(pad)));
      // Nothing comes nearer than the fit distance, so a far near plane keeps the depth precise at the pad.
      camera.near = Math.max(0.05, frame.radius / 50);
      camera.far = frame.radius * 50 + frame.ground * 4;
      camera.updateProjectionMatrix();
      place();
      draw();
      const backend = renderer.backend as unknown as { isWebGPUBackend?: boolean };
      host.dataset.backend = backend.isWebGPUBackend === true ? "webgpu" : "webgl2";
      host.dataset.paths = String(paths.filter((p) => p.points.length >= 2).length);
      host.dataset.points = String(paths.reduce((n, p) => n + p.points.length, 0));
      host.dataset.ground = String(frame.ground);
      host.dataset.pad = pad.height.toFixed(2);
      host.dataset.rail = pad.rail.toFixed(2);
      host.dataset.railAngle = String(padSpec?.rail?.angleDeg ?? 0);
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      if (!disposed) host.dataset.ready = "true";
    })().catch((e: unknown) => {
      if (disposed) return;
      host.dataset.ready = "error";
      host.dataset.error = e instanceof Error ? e.message : String(e);
    });

    let drag: { x: number; yaw: number } | null = null;
    const down = (e: PointerEvent) => {
      drag = { x: e.clientX, yaw };
      canvas.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (!drag) return;
      yaw = drag.yaw + (e.clientX - drag.x) * 0.01;
      place();
      draw();
    };
    const up = () => {
      drag = null;
    };
    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    const ro = new ResizeObserver(() => {
      resize();
      draw();
    });
    ro.observe(canvas);
    return () => {
      disposed = true;
      ro.disconnect();
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      for (const d of disposables) d.dispose();
      renderer.dispose();
    };
  }, [paths, padSpec]);

  return (
    <div className="rw-traj" ref={hostRef} data-testid="inset.trajectory">
      <canvas ref={canvasRef} className="rw-traj__canvas" aria-label="Trajectory view" />
      {gizmo && (
        <svg className="rw-traj__gizmo" data-testid="inset.gizmo" viewBox="-30 -30 60 60" width="56" height="56" aria-label="Axes: X east, Y north, Z up">
          {[...gizmo]
            .sort((a, b) => a.depth - b.depth)
            .map((g) => (
              <g key={g.axis} data-axis={g.axis} className={`rw-traj__axis rw-traj__axis--${g.axis.toLowerCase()}`}>
                <line x1={0} y1={0} x2={g.dx * 18} y2={g.dy * 18} />
                <text x={g.dx * 25} y={g.dy * 25} textAnchor="middle" dominantBaseline="central">
                  {g.axis}
                </text>
              </g>
            ))}
        </svg>
      )}
      <ul className="rw-traj__legend rw-list" data-testid="inset.legend">
        {paths.map((p) => (
          <li key={p.id} data-series-color={p.color}>
            <span className="rw-traj__swatch" style={{ background: p.color }} aria-hidden />
            {p.label}
          </li>
        ))}
      </ul>
    </div>
  );
}
