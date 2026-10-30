/**
 * Simulate > Propulsion simulation (concept 06). Mode tabs Engineering |
 * Visual flow | Imported CFD, one result view per tier, each with its own
 * provenance (C §4.6). M4.8 lands the Engineering tier (`engineering.tsx`),
 * M5.1-M5.3 the Visual flow tier (`visual.tsx`: GPU fluid, cutaway,
 * transport, traces), and M5.4 the Imported CFD tier (`cfd.tsx`). No tier
 * shows another tier's numbers (I13). M5.5 adds the rail extras
 * (`analysis.tsx`): Trajectory and Stability analysis from the project's
 * flight runs and the Thermal analysis empty state, addressed as the page's
 * `tab` (`trajectory`, `stability`, `thermal`) so the header stays on
 * Simulate.
 */
import type { ReactNode } from "react";
import { Icon } from "../../shell/Icon.tsx";
import type { RpcLike } from "../../state/rpc.ts";
import { useAppState, type AppStore } from "../../state/index.ts";
import type { RunDataSource } from "../results/source.ts";
import { AnalysisPage } from "./analysis.tsx";
import { ANALYSIS_VIEWS, isAnalysisView } from "./analysisModel.ts";
import { CfdTab, createCfdUi, type CfdStore } from "./cfd.tsx";
import { createEngineeringUi, EngineeringTab, type EngineeringStore } from "./engineering.tsx";
import { createVisualUi, VisualFlowTab, type VisualStore } from "./visual.tsx";
import "./propsim.css";

export const TIER_TABS = [
  { id: "engineering", label: "Engineering" },
  { id: "visual", label: "Visual flow" },
  { id: "cfd", label: "Imported CFD" },
] as const;
export type TierTab = (typeof TIER_TABS)[number]["id"];
export const isTierTab = (t: string | null | undefined): t is TierTab => TIER_TABS.some((x) => x.id === t);

export interface PropSimSlots {
  content: ReactNode;
  nav: ReactNode;
}

export function propSimSlots(
  store: AppStore,
  client: RpcLike | null,
  httpBase: string,
  ui: EngineeringStore = createEngineeringUi(),
  visualUi: VisualStore = createVisualUi(),
  cfdUi: CfdStore = createCfdUi(),
  runSource: RunDataSource | null = null,
): PropSimSlots {
  return {
    content: <PropSimWorkspace store={store} client={client} httpBase={httpBase} ui={ui} visualUi={visualUi} cfdUi={cfdUi} runSource={runSource} />,
    nav: <SimulationNav store={store} />,
  };
}

function PropSimWorkspace({
  store,
  client,
  httpBase,
  ui,
  visualUi,
  cfdUi,
  runSource,
}: {
  store: AppStore;
  client: RpcLike | null;
  httpBase: string;
  ui: EngineeringStore;
  visualUi: VisualStore;
  cfdUi: CfdStore;
  runSource: RunDataSource | null;
}) {
  const raw = useAppState(store, (s) => s.ui.tab);
  if (isAnalysisView(raw)) return <AnalysisPage store={store} view={raw} source={runSource} />;
  const tier: TierTab = isTierTab(raw) ? raw : "engineering";
  return (
    <div className="rw-propsim" data-testid="propsim-page" data-tier={tier}>
      <header className="rw-propsim__head">
        <h1 className="rw-page-title" data-testid="page.title">
          Propulsion simulation
        </h1>
      </header>
      <nav className="rw-propsim__tabs" role="tablist" aria-label="Simulation tier">
        {TIER_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            className="rw-tab rw-tab--editor"
            data-testid="propsim.tier-tab"
            data-tier={t.id}
            aria-selected={t.id === tier}
            onClick={() => store.getState().ui.navigate("propulsion-sim", t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>
      <div className="rw-propsim__body">
        {tier === "engineering" ? (
          <EngineeringTab store={store} client={client} ui={ui} httpBase={httpBase} />
        ) : tier === "visual" ? (
          <VisualFlowTab store={store} client={client} ui={visualUi} httpBase={httpBase} />
        ) : (
          <CfdTab store={store} client={client} ui={cfdUi} httpBase={httpBase} />
        )}
      </div>
    </div>
  );
}

/** The `Simulation` rail rows (concept 06): this page's tiers, then the analysis pages. */
export const SIM_ROWS = [
  { id: "propulsion", label: "Propulsion simulation", icon: "play-circle" as const },
  { id: "trajectory", label: ANALYSIS_VIEWS[0].label, icon: "trend" as const },
  { id: "stability", label: ANALYSIS_VIEWS[1].label, icon: "stability" as const },
  { id: "thermal", label: ANALYSIS_VIEWS[2].label, icon: "thermometer" as const },
];

/** The rail row the page's `tab` belongs to (a tier tab is Propulsion simulation). */
export const simRowOf = (tab: string | null | undefined): string => (isAnalysisView(tab) ? tab : "propulsion");

/** The `Simulation` rail section: Propulsion simulation (the tiers) and the Trajectory, Stability, and Thermal analysis pages. */
function SimulationNav({ store }: { store: AppStore }) {
  const page = useAppState(store, (s) => s.ui.page);
  const tab = useAppState(store, (s) => s.ui.tab);
  const active = page === "propulsion-sim" ? simRowOf(tab) : null;
  const open = (id: string) => {
    // Propulsion simulation reopens the tier the user last had (Visual flow by default).
    store.getState().ui.navigate("propulsion-sim", id === "propulsion" ? (lastTier.get(store) ?? "visual") : id);
  };
  if (page === "propulsion-sim" && isTierTab(tab)) lastTier.set(store, tab);
  return (
    <ul className="rw-list" role="listbox" aria-label="Simulation" data-testid="simulation.nav">
      {SIM_ROWS.map((r) => (
        <li key={r.id} className="rw-nav-row" role="option" data-testid="rail.nav-row" data-row={r.id} aria-selected={r.id === active} onClick={() => open(r.id)}>
          <span className="rw-thumb" data-testid="rail.thumb">
            <Icon name={r.icon} size={20} className="rw-nav-row__part" />
          </span>
          <span className="rw-nav-row__label">{r.label}</span>
        </li>
      ))}
    </ul>
  );
}

/** The last tier tab shown per store (Propulsion simulation reopens it). */
const lastTier = new WeakMap<AppStore, TierTab>();
