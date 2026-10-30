/** Reads evaluated component dimensions for detail builders (SI metres). */
import type { EvalComponent } from "./types.ts";

/** A numeric field of the evaluated shape, or 0. */
export function dim(c: EvalComponent, key: string): number {
  const v = (c.shape as unknown as Record<string, unknown>)[key];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
