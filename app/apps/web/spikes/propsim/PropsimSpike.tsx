/**
 * RL1d: the page 06 integrated cutaway prototype on the concept camera
 * (`?mode=spike&spike=propsim[&t=<s>][&play=1][&study=<file>]`). The
 * production Visual flow view (`src/pages/propsim/visual.tsx`: shell cut
 * with cut faces, transparent tank, MLS-MPM liquid with its reconstructed
 * surface, draining, feed line and nozzle, white streamlines, transport,
 * synced traces) on a canned study timeline (`study-01.visual.json`, a
 * real `rw sim study_01` run of the research vehicle), with no server,
 * placed where concept 06 puts the content pane (x 262, y 107, 892 wide).
 * Reports on `window.__rwFluid`. M5.2/M5.3 productionize it (docs/dev/spikes.md).
 */
import { useMemo } from "react";
import "../../src/pages/propsim/propsim.css";
import { parseVisualRun } from "../../src/fluid/timeline.ts";
import { createTransport } from "../../src/pages/propsim/transport.tsx";
import { createVisualUi, VisualFlowView } from "../../src/pages/propsim/visual.tsx";
import study from "./study-01.visual.json?raw";

const STUDIES = [
  { id: "study_01", name: "Study 01" },
  { id: "tank_motion", name: "Tank motion" },
  { id: "flow_overview", name: "Flow overview" },
];

export function PropsimSpike() {
  const params = new URLSearchParams(window.location.search);
  const record = useMemo(() => parseVisualRun(study), []);
  const ui = useMemo(createVisualUi, []);
  const transport = useMemo(() => {
    const t = createTransport(record.duration);
    const at = Number(params.get("t") ?? "0");
    if (at > 0) t.getState().seek(at);
    if (params.get("play") === "1") t.getState().play();
    return t;
  }, [record]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="rw-spike-propsim" style={{ position: "fixed", inset: 0, background: "var(--rw-bg-canvas)" }}>
      <div style={{ position: "absolute", left: 262, top: 107, width: 892, height: 802 }}>
        <VisualFlowView
          studies={STUDIES}
          selected="study_01"
          onSelect={() => undefined}
          record={record}
          state="ready"
          error={null}
          ui={ui}
          transport={transport}
          stageOptions={{ debugParticles: params.get("particles") === "1" }}
        />
      </div>
    </div>
  );
}
