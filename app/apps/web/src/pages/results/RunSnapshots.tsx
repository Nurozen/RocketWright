/**
 * Run snapshot row (C §3, §4.4): the history strip's second row on Results.
 * One card per plotted run: thumbnail, colour dot, `<run> run`, the model
 * revision it ran on, and that revision's time. Clicking selects the run.
 * The thumbnail is the rocket rendered on the studio stage (PBR, contact
 * shadow; the thumbnail cache's `SNAPSHOT_KEY`), else a line glyph.
 */
import { useMemo } from "react";
import { SNAPSHOT_KEY } from "../../render/thumbnails.ts";
import { useAppState, type AppStore } from "../../state/store.ts";
import { runSnapshots } from "./model.ts";
import { useResultsRows } from "./parts.tsx";

/** The rendered rocket (`data-source="render"`), else a side-profile glyph of a generic rocket. */
function Thumb({ url }: { url: string | undefined }) {
  if (url !== undefined)
    return (
      <span className="rw-snap__thumb rw-snap__thumb--render" data-testid="history.snapshot-thumb" data-source="render" aria-hidden>
        <img src={url} alt="" draggable={false} />
      </span>
    );
  return (
    <svg className="rw-snap__thumb" data-testid="history.snapshot-thumb" data-source="icon" viewBox="0 0 100 60" aria-hidden>
      <g transform="rotate(-22 50 30)">
        <path className="rw-snap__body" d="M14 30 Q24 24 34 24 H78 V36 H34 Q24 36 14 30 Z" />
        <path className="rw-snap__band" d="M52 24 H56 V36 H52 Z M70 24 H72 V36 H70 Z" />
        <path className="rw-snap__fin" d="M68 24 L84 14 L86 24 Z M68 36 L84 46 L86 36 Z" />
        <path className="rw-snap__motor" d="M78 26 H84 V34 H78 Z" />
      </g>
    </svg>
  );
}

export function RunSnapshots({ app }: { app: AppStore }) {
  const rows = useResultsRows(app, { sorted: false });
  const history = useAppState(app, (s) => s.project.snapshot?.history);
  const cards = useMemo(() => runSnapshots(app.getState(), rows), [app, rows, history]);
  const thumb = useAppState(app, (s) => s.thumbs.urls[SNAPSHOT_KEY]);
  return (
    <div className="rw-snaps" data-rw-region="run-snapshots" data-testid="run-snapshots">
      {cards.length === 0 && <p className="rw-snaps__empty">No runs yet. Run a simulation to see it here.</p>}
      {cards.map((c) => (
        <button
          key={c.key}
          type="button"
          className="rw-snap"
          data-testid="history.snapshot"
          data-sim={c.sim}
          data-series={c.series ?? undefined}
          onClick={() => app.getState().selection.select([c.ref], "history")}
        >
          <Thumb url={thumb} />
          <span className="rw-snap__text">
            <span className="rw-snap__title">
              <span className="rw-dot" data-series={c.series ?? "none"} />
              {c.title}
            </span>
            <span className="rw-snap__meta">{c.modelRev}</span>
            <span className="rw-snap__meta">{c.when}</span>
          </span>
        </button>
      ))}
    </div>
  );
}
