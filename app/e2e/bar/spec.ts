/**
 * Types and loaders for the bar spec data in `tests/bar/`:
 * `tokens.json` (concepts.md §2), `regions.json`, and `checklists/NN.json`.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { CHECKLIST_DIR, REGIONS_PATH, TOKENS_PATH, readJson, type PageId } from "./paths.ts";

/** `[x, y, width, height]` in CSS px at DPR 1 (equal to exemplar px). */
export type Rect = [number, number, number, number];

// ---- tokens.json ---------------------------------------------------------------

export interface ColorToken {
  /** Canonical value (what `tokens.css` uses). */
  value: string;
  /** Further accepted references: C §2 pixel samples and calibrated exemplar samples. */
  accept: string[];
  use: string;
}

/** DOM mode: a computed-style colour of an element, bound to a token. */
export interface DomBinding {
  token: string;
  /** Region name from regions.json, or a CSS selector when `selector` is set. */
  region?: string;
  selector?: string;
  /** CSS property read with getComputedStyle, e.g. `background-color`. */
  property: string;
  /** Pages the binding applies to ("*" = all). */
  pages: string[] | "*";
  /**
   * D31: when the page shows the Lecturn embed, the binding is read in the
   * embed's webContents with this selector instead (Lecturn's own
   * `data-*` hooks; no RocketWright test ids exist inside the pane).
   */
  embed?: string;
  note?: string;
}

/**
 * D31: a pixel probe inside the embedded pane, sampled (median) from the
 * composite capture. `embed` names an element in the guest whose box (shrunk
 * by `inset` px) is sampled; without it `rect` is relative to the embed
 * rect's top-left. `name` keys the row (`pane <name>` in reports).
 */
export interface PaneProbe {
  name: string;
  token: string;
  embed?: string;
  rect?: Rect;
  inset?: number;
  pages: string[] | "*";
  note: string;
}

/** Image mode: a pixel sample (median over a rect) bound to a token. */
export interface ImageProbe {
  token: string;
  rect: Rect;
  note: string;
}

export interface TypographyRole {
  selector: string;
  /** D31: the role's selector in the embed's webContents when the page shows the embed. */
  embed?: string;
  /** Allowed font-size range in px, inclusive. */
  px: [number, number];
  pages: string[] | "*";
}

export interface TokensSpec {
  version: number;
  source: string;
  tolerance: { deltaE2000: number };
  colors: Record<string, ColorToken>;
  typography: {
    family: string[];
    tabularNumbers: boolean;
    monospace: boolean;
    roles: Record<string, TypographyRole>;
  };
  shape: { radiusPx: [number, number]; shadows: string };
  spacing: Record<string, number | [number, number]>;
  layout: Record<string, number>;
  forbidden: string[];
  bindings: DomBinding[];
  probes: Partial<Record<PageId, ImageProbe[]>>;
  /** D31: pixel probes in the embedded pane's rect (live captures only). */
  paneProbes: PaneProbe[];
}

// ---- regions.json --------------------------------------------------------------

export type Dim = "w" | "h";

export interface RegionDef {
  /** `[data-rw-region="<name>"]` unless overridden. */
  selector: string;
  /** D31: the region's element in the embed's webContents (offset by the embed rect) when the page shows the embed. */
  embed?: string;
  desc: string;
  source: string;
}

export interface PageRegions {
  exemplar: string;
  title: string;
  /** Exemplar rects (px), measured from the PNG hairlines; calibrate re-detects them. */
  rects: Record<string, Rect>;
  /** Dimensions checked against the exemplar proportion (±tolerance). */
  check: Record<string, Dim[]>;
  /**
   * D31: rects and checks that replace the exemplar's in DOM mode when the
   * page shows the Lecturn embed (from the approved mockup,
   * `rocketwright-embedded-chat.png`). Image-mode calibration on the concept
   * art keeps `rects`/`check`.
   */
  embed?: { rects: Record<string, Rect>; check: Record<string, Dim[]> };
}

export interface RegionsSpec {
  version: number;
  viewport: { width: number; height: number; dpr: number };
  tolerance: { proportion: number };
  regions: Record<string, RegionDef>;
  pages: Record<PageId, PageRegions>;
}

// ---- checklists ----------------------------------------------------------------

export const ITEM_KINDS = ["region", "control", "field", "state", "render"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];
export const MILESTONES = ["M1", "M2", "M3", "M4", "M5"] as const;
export type Milestone = (typeof MILESTONES)[number];
export const LEVELS = ["required", "minimal"] as const;
export type Level = (typeof LEVELS)[number];

export interface ChecklistItem {
  /** `<page>.<area>.<name>`, unique across all checklists. */
  id: string;
  kind: ItemKind;
  /** `data-testid` (or the `data-rw-region` name for `region` items) the e2e tests and token script resolve. */
  testid: string;
  /** The milestone whose gate first requires the item. */
  milestone: Milestone;
  /** Where the requirement comes from: `C§4.1`, `S:169`, `D10`, `U8`, … */
  source: string;
  /** What the critic looks for. Never the art's illustrative numbers. */
  text: string;
  /** `minimal`: present as a minimal or empty-state element (D10: U11, U17-U20). */
  level: Level;
}

export interface Checklist {
  page: PageId;
  title: string;
  exemplar: string;
  /** The app state the capture script drives to (S:169). */
  captureState: string;
  source: string;
  items: ChecklistItem[];
}

export function loadTokens(path: string = TOKENS_PATH): TokensSpec {
  return readJson<TokensSpec>(path);
}

export function loadRegions(path: string = REGIONS_PATH): RegionsSpec {
  return readJson<RegionsSpec>(path);
}

/** All checklist files `NN.json` in `dir`, keyed by file name. */
export function loadChecklists(dir: string = CHECKLIST_DIR): Map<string, Checklist> {
  const out = new Map<string, Checklist>();
  for (const f of readdirSync(dir).sort()) {
    if (/^\d\d\.json$/.test(f)) out.set(f, readJson<Checklist>(join(dir, f)));
  }
  return out;
}

export function appliesTo(pages: string[] | "*", page: string): boolean {
  return pages === "*" || pages.includes(page);
}
