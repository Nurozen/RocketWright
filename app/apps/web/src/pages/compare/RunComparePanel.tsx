/**
 * Two runs side by side (`Show differences ›` on the agent's comparison
 * card, concept 04): run A → run B, whether they flew in the same
 * environment (their manifests' conditions hash), and the summary deltas.
 * Shown at the top of the Compare view when Old and New are both runs.
 */
import type { RunComparisonView } from "./comparison.ts";
import { Icon } from "../../shell/Icon.tsx";

const RUN_METRICS = [
  { key: "apogee_m", label: "Apogee", unit: "m" },
  { key: "max_velocity_ms", label: "Max speed", unit: "m/s" },
  { key: "flight_time_s", label: "Flight time", unit: "s" },
] as const;

/** `+8.2%` from a to b (`—` when either is missing). */
export function runDelta(a: number | null | undefined, b: number | null | undefined): string {
  if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b)) return "—";
  if (a === 0) return b === 0 ? "0%" : "—";
  const pct = ((b - a) / Math.abs(a)) * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
}

export function RunComparePanel({ view, onClose }: { view: RunComparisonView; onClose?: () => void }) {
  const [a, b] = view.runs;
  const env = view.environment === "same" ? "Same environment" : view.environment === "different" ? "Different environments" : "Environment not recorded";
  return (
    <div className="rw-compare" data-testid="history.run-compare" data-environment={view.environment} role="status">
      <span className="rw-compare__title">
        {a?.label ?? "—"} → {b?.label ?? "—"}
      </span>
      <span className="rw-compare__chip" data-kind={view.environment === "different" ? "removed" : view.environment === "same" ? "added" : "changed"}>
        {env}
      </span>
      {RUN_METRICS.map((m) => (
        <span key={m.key} className="rw-compare__metric" data-metric={m.key}>
          {m.label} {runDelta(a?.entry?.summary?.[m.key], b?.entry?.summary?.[m.key])}
        </span>
      ))}
      {onClose && (
        <button type="button" className="rw-icon-button" aria-label="Close compare" onClick={onClose}>
          <Icon name="close" size={16} />
        </button>
      )}
    </div>
  );
}
