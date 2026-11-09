/**
 * Collapsible inspector strip at the right edge of the 01 workspace (concepts
 * §4.1): `<Part> ›` title, then the Attachment, Mass, and Clearance cards.
 */
import { useState, type ReactNode } from "react";
import { Icon, type IconName } from "../../shell/Icon.tsx";
import { PartThumb } from "../../render/PartThumb.tsx";
import { ADD_FIRST_PART } from "../../state/empty-text.ts";
import type { InspectorRow, InspectorView } from "./inspector-model.ts";

export interface InspectorProps {
  view: InspectorView | null;
  /** Header card (M3.6): the selected part's rendered thumbnail, or its icon until one is cached. */
  thumb?: { url: string | undefined; icon: IconName } | null;
  /** The project has no parts: there is nothing to select yet (R0.3a). */
  noParts?: boolean;
  /** Controls for the selected part, below its cards. */
  actions?: ReactNode;
}

export const INSPECTOR_WIDTH = 224;

function Card({ title, testid, rows }: { title: string; testid: string; rows: InspectorRow[] }) {
  return (
    <section className="rw-insp-card" data-testid={testid} aria-label={title}>
      <h3 className="rw-insp-card__title">
        <span>{title}</span>
        <Icon name="chevron-right" size={16} />
      </h3>
      <dl className="rw-insp-card__rows">
        {rows.map((r) => (
          <div
            key={r.key}
            className="rw-insp-row"
            data-row={r.key}
            data-pass={r.pass === undefined ? undefined : String(r.pass)}
            data-severity={r.severity}
          >
            <dt title={r.label}>{r.label}</dt>
            <dd title={r.value}>{r.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function Inspector({ view, thumb = null, noParts = false, actions }: InspectorProps) {
  const [open, setOpen] = useState(true);
  return (
    <aside
      className="rw-inspector"
      data-rw-region="inspector"
      data-testid="inspector"
      data-open={String(open)}
      data-part={view?.id ?? ""}
      style={{ width: open ? INSPECTOR_WIDTH : undefined }}
    >
      <header className="rw-inspector__head">
        <h2 className="rw-inspector__title" data-testid="insp.title">
          {view ? view.title : noParts ? "No parts yet" : "Nothing selected"}
        </h2>
        <button
          type="button"
          className="rw-icon-button rw-inspector__toggle"
          data-testid="insp.collapse"
          aria-expanded={open}
          aria-label={open ? "Collapse inspector" : "Expand inspector"}
          onClick={() => setOpen(!open)}
        >
          <Icon name="chevron-right" size={18} />
        </button>
      </header>
      {open &&
        (view ? (
          <>
            {thumb && <PartThumb url={thumb.url} icon={thumb.icon} size={96} width={INSPECTOR_WIDTH - 28} testId="insp.thumbnail" className="rw-inspector__thumb" />}
            <Card title="Attachment" testid="insp.attachment" rows={view.attachment} />
            <Card title="Mass" testid="insp.mass" rows={view.mass} />
            <Card title="Clearance" testid="insp.clearance" rows={view.clearance} />
            {actions !== undefined && <div className="rw-inspector__actions">{actions}</div>}
          </>
        ) : (
          <p className="rw-inspector__empty">{noParts ? `${ADD_FIRST_PART}.` : "Select a part in the tree or the viewport."}</p>
        ))}
    </aside>
  );
}
