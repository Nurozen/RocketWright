/**
 * Configurations > Motors > Search ThrustCurve: an inline panel under the
 * picker's search box. Nothing reaches the network until the user presses
 * Search (`motor.thrustcurveSearch` → the sidecar's `thrustcurve_search`);
 * Import downloads one motor's data file into the project's `lib/motors/`
 * (`motor.thrustcurveFetch`), and the caller adds its curves to the picker.
 */
import { useState, type FormEvent } from "react";
import type { schema } from "@rw/contracts";
import { Icon } from "../../shell/Icon.tsx";
import type { RpcLike } from "../../state/rpc.ts";
import type { DeepReadonly } from "../../state/index.ts";
import { hasCriteria, thrustcurveRow, type ThrustcurveCriteria } from "./thrustcurve.ts";

type Curve = DeepReadonly<schema.ThrustCurve>;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function ThrustcurvePanel({
  client,
  projectId,
  initial,
  onImported,
  onClose,
}: {
  client: RpcLike | null;
  projectId: string | null;
  initial: ThrustcurveCriteria;
  onImported: (curves: Curve[], path: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState(initial.query ?? "");
  const [results, setResults] = useState<schema.ThrustcurveSearchOut | null>(null);
  const [busy, setBusy] = useState<"search" | string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const { query: _initialQuery, ...rest } = initial;
  const criteria: ThrustcurveCriteria = query.trim() === "" ? rest : { ...rest, query: query.trim() };
  const filters = [initial.diameter, initial.impulse_class !== undefined ? `class ${initial.impulse_class}` : undefined, initial.manufacturer].filter((x) => x !== undefined);
  const offline = client === null || projectId === null;

  const search = (e: FormEvent) => {
    e.preventDefault();
    if (offline || busy !== null || !hasCriteria(criteria)) return;
    setBusy("search");
    setError(null);
    setSaved(null);
    client
      .call("motor.thrustcurveSearch", { projectId, ...criteria })
      .then((out) => setResults(out))
      .catch((x: unknown) => setError(message(x)))
      .finally(() => setBusy(null));
  };

  const importMotor = (m: DeepReadonly<schema.ThrustcurveMotor>) => {
    if (offline || busy !== null) return;
    setBusy(m.motor_id);
    setError(null);
    setSaved(null);
    client
      .call("motor.thrustcurveFetch", { projectId, motor: m.motor_id })
      .then((out) => {
        setSaved(out.path);
        onImported(out.curves as Curve[], out.path);
      })
      .catch((x: unknown) => setError(message(x)))
      .finally(() => setBusy(null));
  };

  return (
    <section className="rw-tc" data-testid="thrustcurve.panel" aria-label="Search ThrustCurve">
      <div className="rw-tc__head">
        <span className="rw-tc__title">ThrustCurve</span>
        <button type="button" className="rw-icon-button" aria-label="Close ThrustCurve search" data-testid="thrustcurve.close" onClick={onClose}>
          <Icon name="close" size={16} />
        </button>
      </div>
      <p className="rw-tc__note">Searches thrustcurve.org over the network; nothing is sent until you search.</p>
      <form className="rw-tc__form" onSubmit={search}>
        <input
          className="rw-tc__query"
          data-testid="thrustcurve.query"
          aria-label="ThrustCurve designation"
          placeholder="Designation, e.g. Estes C6"
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
        />
        <button type="submit" className="rw-button rw-button--primary rw-tc__go" data-testid="thrustcurve.search" disabled={offline || busy !== null || !hasCriteria(criteria)}>
          {busy === "search" ? "Searching…" : "Search"}
        </button>
      </form>
      {filters.length > 0 && <p className="rw-tc__filters">Also filtered by {filters.join(", ")} (the picker's filters).</p>}
      {error !== null && (
        <p className="rw-tc__error" role="alert" data-testid="thrustcurve.error">
          {error}
        </p>
      )}
      {saved !== null && (
        <p className="rw-tc__saved" role="status" data-testid="thrustcurve.saved">
          Saved {saved}. Assign to configuration flies it.
        </p>
      )}
      {results !== null && (
        <ul className="rw-tc__rows" data-testid="thrustcurve.list" aria-label="ThrustCurve results">
          {results.motors.length === 0 && <li className="rw-motors__empty">No ThrustCurve motors match.</li>}
          {results.motors.map((m) => {
            const row = thrustcurveRow(m);
            return (
              <li key={m.motor_id} className="rw-tc__row" data-testid="thrustcurve.row" data-motor-id={m.motor_id}>
                <span className="rw-motors__name">
                  <span>{row.title}</span>
                  <span className="rw-motors__sub">{row.detail}</span>
                </span>
                <button
                  type="button"
                  className="rw-button rw-button--quiet rw-tc__import"
                  data-testid="thrustcurve.import"
                  disabled={busy !== null || m.data_files === 0}
                  title={m.data_files === 0 ? "ThrustCurve has no data file for this motor" : `Download ${row.title} into lib/motors/`}
                  onClick={() => importMotor(m)}
                >
                  {busy === m.motor_id ? "Importing…" : "Import"}
                </button>
              </li>
            );
          })}
          {results.matches > results.motors.length && (
            <li className="rw-motors__empty">
              {results.motors.length} of {results.matches} shown; narrow the search.
            </li>
          )}
        </ul>
      )}
    </section>
  );
}
