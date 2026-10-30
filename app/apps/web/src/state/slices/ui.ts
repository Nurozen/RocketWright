/** `ui`: page, local tab, and viewport presentation state (not model data). */
import type { PageId, ViewId } from "@rw/contracts";
import type { SliceCtx, UiSlice } from "../types.ts";

const clamp01 = (x: number): number => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

export function createUiSlice(ctx: SliceCtx): UiSlice {
  return {
    page: "assembly",
    tab: null,
    view: "iso",
    explode: 0,
    explodeAnimate: false,
    section: false,
    showInternals: false,
    shadows: true,
    units: "mm",
    hidden: [],
    compare: null,
    focusStep: null,
    navigate(page: PageId, tab?: string): void {
      ctx.patch("ui", { page, tab: tab ?? null });
    },
    setView(v): void {
      const out: Partial<UiSlice> = {};
      if (v.view !== undefined) out.view = v.view satisfies ViewId;
      if (v.explode !== undefined) {
        out.explode = clamp01(v.explode);
        out.explodeAnimate = v.animate === true;
      }
      if (v.section !== undefined) out.section = v.section;
      if (v.showInternals !== undefined) out.showInternals = v.showInternals;
      if (v.shadows !== undefined) out.shadows = v.shadows;
      ctx.patch("ui", out);
    },
    setUnits(units): void {
      ctx.patch("ui", { units });
    },
    setCompare(sel): void {
      ctx.patch("ui", { compare: sel === null ? null : { old: sel.old, new: sel.new } });
    },
    setFocusStep(seq: number | null): void {
      ctx.patch("ui", (u) => (u.focusStep === seq ? {} : { focusStep: seq }));
    },
    toggleHidden(id: string): void {
      ctx.patch("ui", (u) => ({ hidden: u.hidden.includes(id) ? u.hidden.filter((x) => x !== id) : [...u.hidden, id] }));
    },
  };
}
