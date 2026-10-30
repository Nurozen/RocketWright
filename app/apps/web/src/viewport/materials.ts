/**
 * PBR look per component appearance (IF1 `appearance`, concept 01 materials:
 * satin white composite, machined aluminium, clear polycarbonate bay, orange
 * nylon, PCB green). Data only; `scene.ts` turns it into node materials.
 * Visual tier only (I13): none of this feeds mass or aero.
 */
import type { schema } from "@rw/contracts";

type Appearance = schema.Appearance;
type AppearancePreset = schema.AppearancePreset;
type ComponentType = schema.ComponentType;

export interface PbrLook {
  /** sRGB hex. */
  color: string;
  metalness: number;
  roughness: number;
  /** 0..1; < 1 renders blended (compare dimming, x-ray). Clear parts stay at 1 and use `transmission`. */
  opacity: number;
  clearcoat: number;
  /** Clear parts show the parts inside them. */
  clear: boolean;
  /** Clear-coat roughness (gloss of the coat). */
  clearcoatRoughness: number;
  /** 0..1 raster transmission (RL1: clear parts transmit, never blend). */
  transmission: number;
  /** Index of refraction (dielectrics). */
  ior: number;
  /** Brushed-metal anisotropy strength (circumferential, needs tangents: `presets.ts`). */
  anisotropy: number;
  /** Fabric sheen. */
  sheen: number;
  /** Dielectric specular scale (1 = F0 0.04). */
  specularIntensity: number;
}

const LOOK = (color: string, metalness: number, roughness: number, extra: Partial<PbrLook> = {}): PbrLook => ({
  color,
  metalness,
  roughness,
  opacity: 1,
  clearcoat: 0,
  clear: false,
  clearcoatRoughness: 0.2,
  transmission: 0,
  ior: 1.5,
  anisotropy: 0,
  sheen: 0,
  specularIntensity: 1,
  ...extra,
});

/**
 * M3.1 appearance presets (concept 01): satin white composite (soft clear
 * coat), brushed aluminium (circumferential anisotropy), clear polycarbonate
 * (transmission, IOR 1.585), orange ripstop (low specular plus sheen, so it
 * stays saturated under Neutral tone mapping), PCB green, black gloss.
 */
export const PRESET_LOOKS: Record<AppearancePreset, PbrLook> = {
  composite_white: LOOK("#e6e5e0", 0.0, 0.46, { clearcoat: 0.3, clearcoatRoughness: 0.35 }),
  composite_gray: LOOK("#a3a7a9", 0.2, 0.5),
  carbon_fiber: LOOK("#2a2d30", 0.3, 0.35, { clearcoat: 0.6, clearcoatRoughness: 0.15 }),
  aluminium_brushed: LOOK("#c6cacf", 1.0, 0.36, { anisotropy: 0.6 }),
  steel_machined: LOOK("#9ea3a8", 1.0, 0.28, { anisotropy: 0.4 }),
  clear_polycarbonate: LOOK("#eef8f9", 0.0, 0.05, { clearcoat: 1, clearcoatRoughness: 0.04, clear: true, transmission: 1, ior: 1.585 }),
  nylon_orange: LOOK("#e0621c", 0.0, 0.72, { sheen: 0.5, specularIntensity: 0.3 }),
  pcb_green: LOOK("#2e6b44", 0.1, 0.5, { clearcoat: 0.4, clearcoatRoughness: 0.3 }),
  black_gloss: LOOK("#18191b", 0.0, 0.18, { clearcoat: 0.8, clearcoatRoughness: 0.06 }),
  kraft_paper: LOOK("#b48a5a", 0.0, 0.85),
  wood: LOOK("#a77b4f", 0.0, 0.7),
};

/** Fallback by kind when a component has no appearance. */
export function defaultPreset(kind: ComponentType | string): AppearancePreset {
  switch (kind) {
    case "parachute":
    case "streamer":
      return "nylon_orange";
    case "mass_component":
      return "pcb_green";
    case "inner_tube":
    case "engine_block":
    case "tank":
      return "aluminium_brushed";
    case "centering_ring":
    case "bulkhead":
    case "coupler":
    case "shock_cord":
      return "composite_gray";
    case "launch_lug":
    case "rail_button":
      return "black_gloss";
    default:
      return "composite_white";
  }
}

/** The look for one component: preset (or kind default) with explicit overrides applied. */
export function lookFor(appearance: Appearance | null | undefined, kind: ComponentType | string): PbrLook {
  const base = PRESET_LOOKS[appearance?.preset ?? defaultPreset(kind)];
  const out = { ...base };
  if (appearance?.color != null && /^#[0-9a-f]{6}$/i.test(appearance.color)) out.color = appearance.color;
  if (appearance?.roughness != null) out.roughness = appearance.roughness;
  if (appearance?.metalness != null) out.metalness = appearance.metalness;
  if (appearance?.transmission != null) {
    out.transmission = Math.min(1, Math.max(0, appearance.transmission));
    out.clear = out.transmission > 0;
  }
  return out;
}

/** Opacity of opaque outer parts while "Show internals" is on (x-ray). */
export const GHOST_OPACITY = 0.18;

/** Selection outline and label colour (accent/teal, concepts.md §2). */
export const SELECTION_TEAL = "#61b5ad";
