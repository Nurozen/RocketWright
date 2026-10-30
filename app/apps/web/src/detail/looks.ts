/**
 * Detail materials (RL5): the finishes detail parts need beyond the
 * component appearance presets (machined aluminium, thread steel, fabric,
 * shroud line, PCB, chips, battery wrap, clear glass). Cached per scene so
 * hundreds of fittings share a handful of materials. Visual tier only (I13).
 */
import * as THREE from "three/webgpu";
import type { PbrLook } from "../viewport/materials.ts";
import { ANISOTROPY_ROTATION, physicalMaterial } from "../viewport/presets.ts";

export type FinishId =
  | "machined"
  | "anodized_dark"
  | "thread"
  | "fabric"
  | "fabric_shade"
  | "line"
  | "pcb"
  | "chip"
  | "gold"
  | "battery"
  | "battery_band"
  | "graphite"
  | "brass"
  | "liner";

interface Finish {
  color: string;
  metalness: number;
  roughness: number;
  clearcoat?: number;
  sheen?: number;
  /** Dielectric specular strength (1 = default F0 0.04); fabric keeps it low so it stays saturated. */
  specular?: number;
  /** Brushed / turned metal (circumferential; `ensureTangents`). */
  anisotropy?: number;
}

/** sRGB colours, PBR parameters. */
export const FINISHES: Record<FinishId, Finish> = {
  machined: { color: "#c9ccd0", metalness: 1, roughness: 0.28, anisotropy: 0.6 },
  anodized_dark: { color: "#4a4f55", metalness: 0.9, roughness: 0.38 },
  thread: { color: "#b9bcc0", metalness: 1, roughness: 0.34, anisotropy: 0.4 },
  fabric: { color: "#e05a14", metalness: 0, roughness: 0.66, specular: 0.2 },
  fabric_shade: { color: "#c84c0c", metalness: 0, roughness: 0.7, specular: 0.2 },
  line: { color: "#b9b6b0", metalness: 0.3, roughness: 0.45 },
  pcb: { color: "#1f6b3e", metalness: 0.05, roughness: 0.45, clearcoat: 0.5 },
  chip: { color: "#16181a", metalness: 0.1, roughness: 0.4 },
  gold: { color: "#d8b25a", metalness: 1, roughness: 0.3 },
  battery: { color: "#1d3f73", metalness: 0.2, roughness: 0.4, clearcoat: 0.4 },
  battery_band: { color: "#e9e6df", metalness: 0, roughness: 0.5 },
  graphite: { color: "#232527", metalness: 0.3, roughness: 0.55 },
  brass: { color: "#c8a35a", metalness: 1, roughness: 0.3 },
  liner: { color: "#c9b48e", metalness: 0, roughness: 0.82 },
};

function physical(f: Finish): THREE.MeshPhysicalNodeMaterial {
  const m = new THREE.MeshPhysicalNodeMaterial({
    color: new THREE.Color(f.color),
    metalness: f.metalness,
    roughness: f.roughness,
    clearcoat: f.clearcoat ?? 0,
    clearcoatRoughness: 0.25,
    side: THREE.DoubleSide,
  });
  if (f.specular !== undefined) m.specularIntensity = f.specular;
  if (f.anisotropy) {
    m.anisotropy = f.anisotropy;
    m.anisotropyRotation = ANISOTROPY_ROTATION;
  }
  if (f.sheen) {
    m.sheen = f.sheen;
    m.sheenColor = new THREE.Color(f.color);
    m.sheenRoughness = 0.6;
  }
  return m;
}

/**
 * Clear polycarbonate for detail glass (RL1 verdict): raster transmission,
 * never blending, so saturated contents (the orange chute) keep their colour.
 * Both walls of a clear layer transmit; the outer (near) layer skips the depth
 * write, so the far wall and anything inside still draw (glass-in-glass rule).
 * `layer: "inner"` is the far wall / nested liner.
 */
export function glassMaterial(look: PbrLook, layer: "outer" | "inner" = "outer"): THREE.MeshPhysicalNodeMaterial {
  const m = physicalMaterial(
    { ...look, transmission: look.transmission > 0 ? look.transmission : 1, roughness: Math.min(look.roughness, 0.06), clearcoat: 1, clearcoatRoughness: 0.04 },
    { side: layer === "outer" ? THREE.FrontSide : THREE.BackSide, clearLayer: layer },
  );
  // Strong studio reflections on the clear wall (exemplar 01 rims).
  m.envMapIntensity = layer === "outer" ? 1.8 : 0.9;
  m.userData["rwGlass"] = true;
  return m;
}

/** One cache per scene; dispose with the scene. */
export class DetailMaterials {
  private readonly cache = new Map<string, THREE.Material>();

  finish(id: FinishId): THREE.MeshPhysicalNodeMaterial {
    return this.get(`finish:${id}`, () => physical(FINISHES[id])) as THREE.MeshPhysicalNodeMaterial;
  }

  /** A finish multiplied by the geometry's `color` attribute (baked fold shading). */
  vertexColored(id: FinishId): THREE.MeshPhysicalNodeMaterial {
    return this.get(`vc:${id}`, () => {
      const m = physical(FINISHES[id]);
      m.vertexColors = true;
      return m;
    }) as THREE.MeshPhysicalNodeMaterial;
  }

  /** The component's own appearance preset (M3.1 `presets.ts`) as an opaque detail material. */
  look(look: PbrLook): THREE.MeshPhysicalNodeMaterial {
    const key = `look:${JSON.stringify(look)}`;
    return this.get(key, () => physicalMaterial({ ...look, transmission: 0, opacity: 1 })) as THREE.MeshPhysicalNodeMaterial;
  }

  /** Glass for a clear look; `back` is the far wall (inner layer, drawn first). */
  glass(look: PbrLook, back = false): THREE.MeshPhysicalNodeMaterial {
    return this.get(`glass:${look.color}:${back}`, () => glassMaterial(look, back ? "inner" : "outer")) as THREE.MeshPhysicalNodeMaterial;
  }

  /** A flat-colour label material (printed text bands, silkscreen). */
  canvas(key: string, draw: (g: CanvasRenderingContext2D, w: number, h: number) => void, w = 256, h = 64): THREE.Material {
    return this.get(`canvas:${key}`, () => {
      if (typeof document === "undefined") return physical(FINISHES.battery_band);
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const g = c.getContext("2d");
      if (g) draw(g, w, h);
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      const m = physical(FINISHES.battery_band);
      m.map = tex;
      m.color = new THREE.Color("#ffffff");
      return m;
    });
  }

  all(): THREE.Material[] {
    return [...this.cache.values()];
  }

  dispose(): void {
    for (const m of this.cache.values()) {
      const map = (m as THREE.MeshPhysicalNodeMaterial).map;
      map?.dispose();
      m.dispose();
    }
    this.cache.clear();
  }

  private get(key: string, make: () => THREE.Material): THREE.Material {
    let m = this.cache.get(key);
    if (!m) {
      m = make();
      m.name = `rw-detail:${key}`;
      this.cache.set(key, m);
    }
    return m;
  }
}
