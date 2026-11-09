/**
 * What Check model found (R2.6): errors and warnings with code, message, part
 * and Go to part, anchored under the header button. It is a dialog, so the
 * desktop app swaps the agent pane for a snapshot while it overlaps the pane.
 */
import { useId } from "react";
import type { RwRef, schema } from "@rw/contracts";
import { componentRef } from "../state/slices/selection.ts";
import { Popover } from "../ui/Popover.tsx";
import { Icon } from "./Icon.tsx";

export interface CheckIssue {
  key: string;
  code: string;
  message: string;
  /** The part's name, or the source location of an issue that is not on a part. */
  where: string | null;
  /** The part to go to: null when the issue is not on a part the model still has. */
  part: RwRef | null;
}

export interface CheckIssues {
  errors: readonly CheckIssue[];
  warnings: readonly CheckIssue[];
}

type IssueSource = Pick<schema.Diagnostic, "code" | "severity" | "message"> & Partial<Pick<schema.Diagnostic, "path" | "file" | "line">>;

/** The part a diagnostic's JSON pointer is on (`/c/<id>/…`), if any. */
function partIdOf(path: string | null | undefined): string | null {
  return /^\/c\/([^/]+)/.exec(path ?? "")?.[1] ?? null;
}

function issueOf(d: IssueSource, index: number, names: ReadonlyMap<string, string>): CheckIssue {
  const id = partIdOf(d.path);
  const name = id === null ? undefined : names.get(id);
  const source = d.file == null ? null : d.line == null ? d.file : `${d.file}:${String(d.line)}`;
  return { key: `${d.code}@${d.path ?? ""}#${String(index)}`, code: d.code, message: d.message, where: name ?? id ?? source, part: id !== null && name !== undefined ? componentRef(id) : null };
}

/** Sorts a report into the panel's groups. Info diagnostics are left out, as they are from the header's status. */
export function checkIssuesOf(diagnostics: readonly IssueSource[], components: readonly { id: string; name: string }[]): CheckIssues {
  const names = new Map(components.map((c) => [c.id, c.name]));
  const of = (severity: schema.Severity): CheckIssue[] => diagnostics.flatMap((d, i) => (d.severity === severity ? [issueOf(d, i, names)] : []));
  return { errors: of("error"), warnings: of("warning") };
}

export interface CheckPanelModel {
  issues: CheckIssues;
  /** A report exists: no rows then means a clean check, not an unchecked model. */
  checked: boolean;
  running: boolean;
  /** Why the last check could not run. */
  error: string | null;
  onRunAgain: () => void;
  onGoToPart: (part: RwRef) => void;
}

export interface CheckIssuesPanelProps extends CheckPanelModel {
  open: boolean;
  anchor: HTMLElement | null;
  onClose: () => void;
}

/** One issue. The row is a group named by its code and part, because every row has a Go to part button (D27). */
function IssueRow({ issue, severity, onGoToPart }: { issue: CheckIssue; severity: "error" | "warning"; onGoToPart: (part: RwRef) => void }) {
  const codeId = useId();
  const whereId = useId();
  const { part } = issue;
  return (
    <div className="rw-check-issues__row" role="group" aria-labelledby={`${codeId} ${whereId}`} data-severity={severity} data-testid="header.check-issue">
      <span className="rw-check-issues__mark">
        <Icon name={severity === "error" ? "error-disc" : "alert-solid"} size={20} label={severity === "error" ? "Error" : "Warning"} />
      </span>
      <span id={codeId} className="rw-check-issues__code">
        {issue.code}
      </span>
      <span className="rw-check-issues__message">{issue.message}</span>
      <span id={whereId} className="rw-check-issues__part" title={issue.where ?? undefined}>
        {issue.where}
      </span>
      {part === null ? (
        <span />
      ) : (
        <button type="button" className="rw-check-issues__goto" onClick={() => onGoToPart(part)}>
          Go to part
        </button>
      )}
    </div>
  );
}

function IssueGroup({ title, severity, issues, onGoToPart }: { title: string; severity: "error" | "warning"; issues: readonly CheckIssue[]; onGoToPart: (part: RwRef) => void }) {
  const headingId = useId();
  if (issues.length === 0) return null;
  return (
    <section className="rw-check-issues__group" role="group" aria-labelledby={headingId}>
      <h3 id={headingId} className="rw-check-issues__heading">
        {title}
      </h3>
      {issues.map((issue) => (
        <IssueRow key={issue.key} issue={issue} severity={severity} onGoToPart={onGoToPart} />
      ))}
    </section>
  );
}

function emptyNote(checked: boolean, running: boolean, failed: boolean): string | null {
  if (running) return "Checking model…";
  if (failed) return null;
  return checked ? "No errors or warnings." : "Model not checked yet.";
}

export function CheckIssuesPanel({ open, anchor, onClose, issues, checked, running, error, onRunAgain, onGoToPart }: CheckIssuesPanelProps) {
  const { errors, warnings } = issues;
  const count = errors.length + warnings.length;
  const note = count === 0 ? emptyNote(checked, running, error !== null) : null;
  return (
    <Popover open={open} anchor={anchor} onClose={onClose} label="Check model" align="end" className="rw-check-issues" testId="header.check-issues">
      <header className="rw-check-issues__head">
        <h2 className="rw-check-issues__title">Check model</h2>
        {count > 0 && (
          <span className="rw-badge" data-tone={errors.length > 0 ? "danger" : "amber"}>
            {count}
          </span>
        )}
      </header>
      <div className="rw-check-issues__body">
        {error !== null && (
          <p className="rw-check-issues__note" data-tone="danger" role="alert">
            Could not run the check: {error}
          </p>
        )}
        {note !== null && <p className="rw-check-issues__note">{note}</p>}
        <IssueGroup title="Errors" severity="error" issues={errors} onGoToPart={onGoToPart} />
        <IssueGroup title="Warnings" severity="warning" issues={warnings} onGoToPart={onGoToPart} />
      </div>
      <footer className="rw-check-issues__foot">
        <button type="button" className="rw-button rw-button--accent" aria-busy={running || undefined} disabled={running} onClick={onRunAgain}>
          <Icon name={running ? "spinner" : "refresh"} size={18} className={running ? "rw-spin" : undefined} />
          Run check again
        </button>
      </footer>
    </Popover>
  );
}
