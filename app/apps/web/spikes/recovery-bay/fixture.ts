/**
 * The research-vehicle fixture (`fixtures/research-vehicle`, the concept-01
 * rocket) bundled as source text, so the spike evaluates and meshes it with
 * rw-wasm in the page exactly like a live project (I4).
 */
import type { SourceFiles } from "@rw/rw-wasm";

const raw = import.meta.glob("../../../../../fixtures/research-vehicle/**/*.toml", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

const PREFIX = "fixtures/research-vehicle/";

export const RESEARCH_VEHICLE: SourceFiles = Object.fromEntries(
  Object.entries(raw).map(([path, text]) => [path.slice(path.indexOf(PREFIX) + PREFIX.length), text]),
);
