/**
 * Results page presentation state shared by its three mount points (workspace
 * body, Runs rail, run snapshot row): sort, plot tab, rail eye toggles, and
 * the event-line switch. One store per app store; not model data.
 */
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { AppStore } from "../../state/store.ts";
import type { PlotTabId } from "../../plots/quantities.ts";
import type { SortState } from "./model.ts";

export interface ResultsUi {
  sort: SortState | null;
  plotTab: PlotTabId;
  /** Run rows (`rowKey`) hidden with the rail eye toggle (dropped from the table and plots). */
  hidden: string[];
  showEvents: boolean;
  set(p: Partial<Omit<ResultsUi, "set" | "toggleHidden">>): void;
  toggleHidden(sim: string): void;
}

const stores = new WeakMap<AppStore, StoreApi<ResultsUi>>();

export function resultsUiStore(app: AppStore): StoreApi<ResultsUi> {
  let s = stores.get(app);
  if (s === undefined) {
    s = createStore<ResultsUi>()((set) => ({
      sort: null,
      plotTab: "altitude",
      hidden: [],
      showEvents: true,
      set: (p) => set(p),
      toggleHidden: (sim) => set((u) => ({ hidden: u.hidden.includes(sim) ? u.hidden.filter((x) => x !== sim) : [...u.hidden, sim] })),
    }));
    stores.set(app, s);
  }
  return s;
}

export function useResultsUi<T>(app: AppStore, selector: (u: ResultsUi) => T): T {
  return useStore(resultsUiStore(app), selector);
}
