/**
 * RocketWright's own settings (R3.4): the default units new projects start
 * with, written at once by whichever host keeps them. The Agent providers
 * entry opens Lecturn's panel in the agent pane, so it is absent with no
 * project on screen (Welcome).
 */
import { useEffect, useId, useState } from "react";
import type { DisplayUnits } from "@rw/contracts";
import type { HostApi } from "../host/HostApi.ts";
import { LENGTH_UNITS } from "../state/displayUnits.ts";
import { Banner } from "../ui/Banner.tsx";
import { Modal } from "../ui/Modal.tsx";
import { Icon } from "./Icon.tsx";
import { errorText } from "./projectActions.ts";

const LABELS: Record<string, string> = { mm: "Millimetres (mm)", cm: "Centimetres (cm)", m: "Metres (m)", in: "Inches (in)" };
/** No preference: `rw init` writes the template's own units. */
const NONE = "";

export interface SettingsDialogProps {
  host: Pick<HostApi, "prefs" | "setPrefs">;
  onClose: () => void;
  /** Absent on Welcome, where there is no pane to open the panel in. */
  onOpenProviders?: (() => void) | undefined;
}

const lengthOf = (units: DisplayUnits | null): string => {
  const length = units?.["length"];
  return length !== undefined && (LENGTH_UNITS as readonly string[]).includes(length) ? length : NONE;
};

export function SettingsDialog({ host, onClose, onOpenProviders }: SettingsDialogProps) {
  const [units, setUnits] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selectId = useId();
  const hintId = useId();

  useEffect(() => {
    let live = true;
    host.prefs().then(
      (p) => {
        if (live) setUnits(lengthOf(p.defaultDisplayUnits));
      },
      (e: unknown) => {
        if (live) setError(`Could not read your settings: ${errorText(e)}`);
      },
    );
    return () => {
      live = false;
    };
  }, [host]);

  const choose = (value: string) => {
    const previous = units;
    setUnits(value);
    setError(null);
    host.setPrefs({ defaultDisplayUnits: value === NONE ? null : { length: value } }).catch((e: unknown) => {
      setUnits(previous);
      setError(`Could not save that setting: ${errorText(e)}`);
    });
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Settings"
      testId="settings"
      footer={
        <button type="button" className="rw-button rw-button--primary" onClick={onClose}>
          Done
        </button>
      }
    >
      <div className="rw-ui-field" data-layout="stacked">
        <label className="rw-ui-field__label" htmlFor={selectId}>
          Default units for new projects
        </label>
        <div className="rw-ui-field__control">
          <span className="rw-select rw-select--native">
            <select id={selectId} data-testid="settings.default-units" aria-describedby={hintId} disabled={units === null} value={units ?? NONE} onChange={(e) => choose(e.currentTarget.value)}>
              <option value={NONE}>Template default</option>
              {LENGTH_UNITS.map((u) => (
                <option key={u} value={u}>
                  {LABELS[u]}
                </option>
              ))}
            </select>
            <Icon name="chevron-down" size={16} />
          </span>
        </div>
        <p id={hintId} className="rw-ui-field__hint">
          Each project keeps its own units; the Units control changes them for the project that is open.
        </p>
      </div>
      {onOpenProviders !== undefined && (
        <button
          type="button"
          className="rw-button"
          onClick={() => {
            onClose();
            onOpenProviders();
          }}
        >
          Agent providers…
        </button>
      )}
      {error !== null && (
        <Banner tone="danger" testId="settings.error">
          {error}
        </Banner>
      )}
    </Modal>
  );
}
