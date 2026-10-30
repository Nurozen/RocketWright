/**
 * Detail-pipeline types (RL5; M3.0 productionizes). A detail builder turns one
 * evaluated component into visual-only meshes: folded fabric, hardware,
 * electronics, bevels. Detail is `provenance=visual` (I13): it never feeds
 * mass, aero, or any engineering number, and it never changes the IF2 model.
 *
 * Frames: builders work in the body frame (+X aft from the nose tip, +Z up,
 * metres) at absolute stations, the same frame as the rw-geom GLB vertices,
 * so a detail group drops straight under the part's GLB node.
 */
import type * as THREE from "three/webgpu";
import type { schema } from "@rw/contracts";
import type { PbrLook } from "../viewport/materials.ts";
import type { DetailMaterials } from "./looks.ts";

export type EvalComponent = schema.EvalComponent;
export type Vec3 = readonly [number, number, number];

export interface DetailContext {
  component: EvalComponent;
  /** The part's resolved look (appearance preset plus overrides). */
  look: PbrLook;
  /** Any component by id (a builder may read its carrier or children). */
  lookup(id: string): EvalComponent | undefined;
  /** Body-frame unit vector toward the default viewer (page 01 framing), so windows and fittings face the camera. */
  showcase: Vec3;
  /** Radial segments for revolved parts. */
  segments: number;
  /** Shared, cached detail materials. */
  materials: DetailMaterials;
}

export interface DetailResult {
  /** Body frame, absolute stations; added under the part's GLB node. */
  group: THREE.Group;
  /**
   * Hide the rw-geom base meshes (default true; through their materials). The
   * base meshes stay the pick proxy (raycasting ignores visibility), so
   * picking keeps the BVH.
   */
  replacesBase?: boolean;
  /** Meshes that draw the selection outline (default: every detail mesh). */
  outline?: THREE.Mesh[];
}

export type DetailBuilder = (ctx: DetailContext) => DetailResult | null;

export interface DetailRule {
  /** Stable builder name (reported in the probe and the spike log). */
  name: string;
  match(c: EvalComponent, ctx: { lookup(id: string): EvalComponent | undefined }): boolean;
  build: DetailBuilder;
  /** Higher wins among matching rules; ties keep registration order. */
  priority?: number;
}

export interface DetailReportRow {
  id: string;
  builder: string;
  meshes: number;
  triangles: number;
}
