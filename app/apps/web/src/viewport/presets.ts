/**
 * M3.1: appearance looks (`materials.ts`) -> `MeshPhysicalNodeMaterial`.
 * One factory for the rw-geom base meshes (`scene.ts`) and the detail
 * meshes (`detail/looks.ts`), so a preset reads the same on both.
 *
 * - Clear parts use raster transmission, never blending (RL1 verdict). They
 *   are thin shells, so the material IOR is 1 (`THIN_WALL_IOR`): three scales
 *   the transmission blur and the refraction offset with the IOR, which
 *   smeared the chute and hid the bay rods at 1.585. The clear coat keeps
 *   the glass reflections (its Fresnel is fixed). In a
 *   nested clear stack every layer transmits and the outer layers do not
 *   write depth (`clearLayer: "outer"`), so the inner layer still draws.
 * - Brushed metal uses anisotropy across the circumferential lathe marks
 *   (highlights stretch along the part: `ANISOTROPY_ROTATION`).
 *   Base meshes have no UVs, so `ensureTangents` writes a tangent attribute
 *   around body +X (the mesh-local axis of every rw-geom and detail mesh).
 *
 * Visual tier only (I13): nothing here feeds mass or aero.
 */
import * as THREE from "three/webgpu";
import type { PbrLook } from "./materials.ts";

export interface PhysicalOptions {
  side?: THREE.Side;
  /** Nested clear layers: `outer` skips the depth write (RL1 glass-in-glass rule). Default `outer`. */
  clearLayer?: "outer" | "inner";
  /** Wall thickness for transmission attenuation (m). */
  thickness?: number;
}

/** Anisotropy direction relative to the circumferential tangent: across the lathe marks (BC5). */
export const ANISOTROPY_ROTATION = Math.PI / 2;

/** Material IOR of transmissive (thin-shell) parts. */
export const THIN_WALL_IOR = 1.0;

/** The physical node material for one look. */
export function physicalMaterial(look: PbrLook, opts: PhysicalOptions = {}): THREE.MeshPhysicalNodeMaterial {
  const m = new THREE.MeshPhysicalNodeMaterial({
    color: new THREE.Color(look.color),
    metalness: look.metalness,
    roughness: look.roughness,
    clearcoat: look.clearcoat,
    clearcoatRoughness: look.clearcoatRoughness,
    ior: look.ior,
    // Section cuts and clear parts show inner walls.
    side: opts.side ?? THREE.DoubleSide,
  });
  applyLook(m, look, opts);
  return m;
}

/** Re-applies a look's parameters to an existing material (compare marks restore through this). */
export function applyLook(m: THREE.MeshPhysicalNodeMaterial, look: PbrLook, opts: PhysicalOptions = {}): void {
  m.color.set(look.color);
  m.metalness = look.metalness;
  m.roughness = look.roughness;
  m.clearcoat = look.clearcoat;
  m.clearcoatRoughness = look.clearcoatRoughness;
  m.ior = look.ior;
  m.specularIntensity = look.specularIntensity;
  m.anisotropy = look.anisotropy;
  // Turned metal: the tangent runs round the circumference (`ensureTangents`); a quarter turn
  // stretches highlights across the lathe marks, along the part (a bright streak, not a lit half).
  if (look.anisotropy > 0) m.anisotropyRotation = ANISOTROPY_ROTATION;
  m.sheen = look.sheen;
  if (look.sheen > 0) {
    m.sheenColor = new THREE.Color(look.color).lerp(new THREE.Color("#ffffff"), 0.35);
    m.sheenRoughness = 0.55;
  }
  m.transmission = look.transmission;
  if (look.transmission > 0) {
    m.ior = THIN_WALL_IOR;
    m.thickness = opts.thickness ?? 0.0016;
    m.attenuationColor = new THREE.Color(look.color);
    m.attenuationDistance = 0.6;
    m.transparent = false;
    m.opacity = 1;
    m.depthWrite = (opts.clearLayer ?? "outer") === "inner";
    m.userData["rwClear"] = true;
    m.userData["rwDepthWrite"] = m.depthWrite;
  } else {
    m.transparent = look.opacity < 1;
    m.opacity = look.opacity;
    m.depthWrite = look.opacity >= 1;
  }
  m.needsUpdate = true;
}

/** Whether a material samples a tangent frame (anisotropy) and so needs `ensureTangents`. */
export function needsTangents(material: THREE.Material | THREE.Material[]): boolean {
  const list = Array.isArray(material) ? material : [material];
  return list.some((m) => (m as THREE.MeshPhysicalNodeMaterial).anisotropy > 0);
}

/**
 * Writes a `tangent` attribute (vec4, w = 1): the circumferential direction
 * about mesh-local +X, so brushed metal streaks run around revolved parts.
 * Points on the axis get the tangent of a nearby direction orthogonal to the
 * normal. Keeps an existing tangent attribute.
 */
export function ensureTangents(geometry: THREE.BufferGeometry): void {
  if (geometry.getAttribute("tangent")) return;
  const pos = geometry.getAttribute("position");
  if (!pos) return;
  const nrm = geometry.getAttribute("normal");
  const out = new Float32Array(pos.count * 4);
  const t = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const r = Math.hypot(y, z);
    if (r > 1e-7) t.set(0, -z / r, y / r);
    else t.set(0, 1, 0);
    if (nrm) {
      // Gram-Schmidt against the normal: flat end faces and fins still get a valid frame.
      n.fromBufferAttribute(nrm, i);
      t.addScaledVector(n, -t.dot(n));
      if (t.lengthSq() < 1e-10) t.set(1, 0, 0).addScaledVector(n, -n.x);
      t.normalize();
    }
    out[i * 4] = t.x;
    out[i * 4 + 1] = t.y;
    out[i * 4 + 2] = t.z;
    out[i * 4 + 3] = 1;
  }
  geometry.setAttribute("tangent", new THREE.BufferAttribute(out, 4));
}
