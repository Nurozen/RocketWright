/** `ui`: page, local tab, and viewport presentation state (not model data). */
import type { DesktopPrefs, PageId, ViewId } from "@rw/contracts";
import { VIEW_IDS } from "../../viewport/views.ts";
import { displayLengthOps, MANIFEST } from "../displayUnits.ts";
import { flushProject, hasUnsavedWork } from "../dirtyFields.ts";
import { createMutate } from "../mutate.ts";
import type { SliceCtx, UiSlice } from "../types.ts";

/** What `setView` restores: the options persisted across launches (R3.4). */
export function viewOptionsOf(ui: Pick<UiSlice, "view" | "explode" | "section" | "showInternals" | "shadows">): DesktopPrefs["view"] {
  return { view: ui.view, explode: ui.explode, section: ui.section, showInternals: ui.showInternals, shadows: ui.shadows };
}

/** Saved options as `setView` arguments, keeping only values that still make sense. */
export function restoredViewOptions(saved: DesktopPrefs["view"]): Parameters<UiSlice["setView"]>[0] {
  const out: Parameters<UiSlice["setView"]>[0] = {};
  if (typeof saved["view"] === "string" && (VIEW_IDS as readonly string[]).includes(saved["view"])) out.view = saved["view"] as ViewId;
  if (typeof saved["explode"] === "number") out.explode = saved["explode"];
  if (typeof saved["section"] === "boolean") out.section = saved["section"];
  if (typeof saved["showInternals"] === "boolean") out.showInternals = saved["showInternals"];
  if (typeof saved["shadows"] === "boolean") out.shadows = saved["shadows"];
  return out;
}

const clamp01 = (x: number): number => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

export function createUiSlice(ctx: SliceCtx): UiSlice {
  const mutate = createMutate(ctx);
  // One write at a time: each reads the manifest after the last one landed, so a quick in-then-cm cannot interleave.
  let unitWrites: Promise<void> = Promise.resolve();
  /** The page change waiting on a flush or on the person; a newer one takes its place. */
  let leave: { go: () => void; done: Promise<void> } | null = null;
  let answer: ((leave: boolean) => void) | null = null;

  const mayLeavePage = async (): Promise<boolean> => {
    const problems = await flushProject({ getState: ctx.get });
    if (problems.length === 0) return true;
    const dropped = await new Promise<boolean>((resolve) => {
      answer = resolve;
      ctx.patch("ui", { leaving: { problems } });
    });
    answer = null;
    ctx.patch("ui", { leaving: null });
    // What could not be saved must not stay open, or it would block every direct edit on the next page.
    if (dropped) ctx.get().draft.discard();
    return dropped;
  };

  /**
   * Runs `go` once the page's typed work is saved. A page's fields unmount with
   * it and React runs no blur for that, so nothing else would ever send the
   * text. With nothing unsaved this stays synchronous.
   */
  const leaving = (go: () => void): Promise<void> => {
    if (leave !== null) {
      leave.go = go;
      return leave.done;
    }
    if (!hasUnsavedWork(ctx.get())) {
      go();
      return Promise.resolve();
    }
    const pending = { go, done: Promise.resolve() };
    pending.done = mayLeavePage()
      .then((ok) => {
        if (ok) pending.go();
      })
      .finally(() => {
        leave = null;
      });
    leave = pending;
    return pending.done;
  };

  const goTo = (page: PageId, tab?: string): Promise<void> => leaving(() => ctx.patch("ui", { page, tab: tab ?? null }));

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
    partDialog: null,
    leaving: null,
    answerLeave(leave: boolean): void {
      answer?.(leave);
    },
    navigate(page: PageId, tab?: string): void {
      void goTo(page, tab);
    },
    goToPage: goTo,
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
    async setProjectUnits(units): Promise<void> {
      const previous = ctx.get().ui.units;
      // Applied now so the select does not jump back while the write is in flight; the commit's manifest then confirms it.
      ctx.patch("ui", { units });
      if (ctx.client === null || ctx.projectId === null) return;
      unitWrites = unitWrites.then(async () => {
        try {
          await mutate(displayLengthOps(ctx.get().project.snapshot?.files.files[MANIFEST], units), `Set units to ${units}`);
        } catch (e) {
          // A newer choice already made owns the control; only say what went wrong.
          const stillShown = ctx.get().ui.units === units;
          ctx.patch("ui", { ...(stillShown ? { units: previous } : {}), partDialog: { kind: "error", title: "Could not change the units", message: e instanceof Error ? e.message : String(e) } });
        }
      });
      return unitWrites;
    },
    setCompare(sel): void {
      void leaving(() => ctx.patch("ui", { compare: sel === null ? null : { old: sel.old, new: sel.new } }));
    },
    setFocusStep(seq: number | null): void {
      ctx.patch("ui", (u) => (u.focusStep === seq ? {} : { focusStep: seq }));
    },
    setPartDialog(partDialog): void {
      ctx.patch("ui", { partDialog });
    },
    toggleHidden(id: string): void {
      ctx.patch("ui", (u) => ({ hidden: u.hidden.includes(id) ? u.hidden.filter((x) => x !== id) : [...u.hidden, id] }));
    },
  };
}
