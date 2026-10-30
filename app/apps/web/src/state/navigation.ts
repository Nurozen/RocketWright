/**
 * Navigation to what a ref names (B12): the embedded pane's
 * `lecturn/navigate {ref}` (`embed/wiring.ts`; chips and card Open actions
 * in the Lecturn timeline), the test hooks' reveal-run (`brokerHost.ts`),
 * and the app's own ref links. Pure TS over the store.
 */
import type { RwRef } from "@rw/contracts";
import { parseRef } from "@rw/contracts";
import { navigatePage } from "../embed/rail.ts";
import { pageOfRef } from "./entities.ts";
import { rowKey } from "./selectors.ts";
import type { AppStore } from "./store.ts";

/** Selects the run and shows Results with it overlaid (the product reveal-run path, not a test hook). */
export async function revealRun(store: AppStore, ref: RwRef): Promise<void> {
  const parsed = parseRef(ref);
  if (!("ok" in parsed) || (parsed.ok.kind !== "run" && parsed.ok.kind !== "sim")) return;
  const s = store.getState();
  const runs = s.project.snapshot?.runs.runs ?? [];
  const entry = parsed.ok.kind === "sim" ? runs.find((r) => r.sim === parsed.ok.id && r.superseded_by == null) : runs.find((r) => r.run_id === parsed.ok.id);
  if (entry !== undefined && !s.runs.overlay.includes(rowKey(entry))) s.runs.toggleOverlay(rowKey(entry));
  s.selection.select([ref], "chat");
  await navigatePage(store, "results");
}

/**
 * A chip, step link or `lecturn/navigate {ref}` (B12): select the entity
 * where it lives.
 * - `rw:c/<id>`: selects the part and frames it in the assembly viewport
 *   (shown again if the tree's eye hid it; Components and Configurations keep
 *   their own view of the assembly);
 * - `rw:run/<id>` (and `rw:sim/<id>`): opens Results with that run; a
 *   visual flow study's `rw:sim/<study>` (the run card's view form, CPW1R3A)
 *   opens that study's section view on the Visual flow tier instead;
 * - `rw:step/<n>` (and `rw:rev/<n>`): opens history at that step (the strip
 *   selects it).
 */
export async function openRef(store: AppStore, ref: RwRef): Promise<void> {
  const parsed = parseRef(ref);
  if (!("ok" in parsed)) return;
  const kind = parsed.ok.kind;
  if (kind === "sim" && visualStudyOf(store, ref) !== null) return openVisualStudy(store, ref);
  if (kind === "run" || kind === "sim") return revealRun(store, ref);
  const s = store.getState();
  if (kind === "c" && s.ui.hidden.includes(parsed.ok.id)) s.ui.toggleHidden(parsed.ok.id);
  s.selection.select([ref], kind === "step" || kind === "rev" ? "history" : "chat");
  const page = pageOfRef(ref);
  if (page !== null && !(page === "assembly" && (s.ui.page === "components" || s.ui.page === "configurations")) && s.ui.page !== page) {
    await navigatePage(store, page);
  }
}

/** The visual flow study a `rw:sim/<id>` ref names, or null. */
export function visualStudyOf(store: AppStore, ref: RwRef): string | null {
  const parsed = parseRef(ref);
  if (!("ok" in parsed) || parsed.ok.kind !== "sim") return null;
  const sims = store.getState().project.snapshot?.evaluated?.sims as Record<string, { kind?: string } | null | undefined> | undefined;
  return sims?.[parsed.ok.id]?.kind === "visual_flow" ? parsed.ok.id : null;
}

/** A visual flow study on the Visual flow tier (the tier follows the selection; the section view is on). */
function openVisualStudy(store: AppStore, ref: RwRef): Promise<void> {
  store.getState().selection.select([ref], "chat");
  return navigatePage(store, "propulsion-sim", "visual");
}
