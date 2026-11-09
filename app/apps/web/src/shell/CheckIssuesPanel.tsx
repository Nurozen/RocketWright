/**
 * What Check model found (R2.6): errors and warnings with code, message, where
 * and a way to go there, anchored under the header button. It is a dialog, so
 * the desktop app swaps the agent pane for a snapshot while it overlaps the pane.
 */
import { useId } from "react";
import type { RwRef, schema } from "@rw/contracts";
import { componentRef } from "../state/slices/selection.ts";
import { Popover } from "../ui/Popover.tsx";
import { DiagnosticText } from "../ui/DiagnosticText.tsx";
import { Icon } from "./Icon.tsx";

export interface CheckIssue {
  key: string;
  code: string;
  message: string;
  /** The name of what it is on, or the source location of an issue that is on nothing in the model. */
  where: string | null;
  /** What to open: null when the issue is on nothing the model still has. */
  target: RwRef | null;
  /** The control's label, as long as there is a target. */
  goTo: string | null;
}

export interface CheckIssues {
  errors: readonly CheckIssue[];
  warnings: readonly CheckIssue[];
}

type IssueSource = Pick<schema.Diagnostic, "code" | "severity" | "message"> & Partial<Pick<schema.Diagnostic, "path" | "file" | "line">>;

type Named = Readonly<Record<string, { readonly name: string } | null | undefined>>;

/** The model's collections other than parts that a diagnostic's pointer can name. */
export interface IssueCollections {
  engines?: Named | null | undefined;
  configs?: Named | null | undefined;
  sims?: Named | null | undefined;
}

/** An engine issue goes to its feed node or edge when the pointer names one, so the Propulsion page opens on it. */
function engineRef(id: string, path: string): RwRef {
  const feed = /^\/engines\/[^/]+\/feed\/(node|edge)\/([^/]+)/.exec(path);
  return feed === null ? `rw:eng/${id}` : `rw:eng/${id}/feed/${feed[1]!}/${feed[2]!}`;
}

/** Where a diagnostic's JSON pointer lands: what it is on, by name, and how to get there. */
function locate(path: string, parts: ReadonlyMap<string, string>, collections: IssueCollections): Pick<CheckIssue, "where" | "target" | "goTo"> | null {
  const m = /^\/(c|engines|configs|sims)\/([^/]+)/.exec(path);
  if (m === null) return null;
  const id = m[2]!;
  const named = (name: string | undefined, target: RwRef, goTo: string) => (name === undefined ? { where: id, target: null, goTo: null } : { where: name, target, goTo });
  switch (m[1]) {
    case "engines":
      return named(collections.engines?.[id]?.name, engineRef(id, path), "Go to engine");
    case "configs":
      return named(collections.configs?.[id]?.name, `rw:cfg/${id}`, "Go to config");
    case "sims":
      return named(collections.sims?.[id]?.name, `rw:sim/${id}`, "Go to sim");
    default:
      return named(parts.get(id), componentRef(id), "Go to part");
  }
}

function issueOf(d: IssueSource, index: number, names: ReadonlyMap<string, string>, collections: IssueCollections): CheckIssue {
  const source = d.file == null ? null : d.line == null ? d.file : `${d.file}:${String(d.line)}`;
  const place = locate(d.path ?? "", names, collections) ?? { where: source, target: null, goTo: null };
  return { key: `${d.code}@${d.path ?? ""}#${String(index)}`, code: d.code, message: d.message, ...place };
}

/** Sorts a report into the panel's groups. Info diagnostics are left out, as they are from the header's status. */
export function checkIssuesOf(diagnostics: readonly IssueSource[], components: readonly { id: string; name: string }[], collections: IssueCollections = {}): CheckIssues {
  const names = new Map(components.map((c) => [c.id, c.name]));
  const of = (severity: schema.Severity): CheckIssue[] => diagnostics.flatMap((d, i) => (d.severity === severity ? [issueOf(d, i, names, collections)] : []));
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
  onGoTo: (target: RwRef) => void;
}

export interface CheckIssuesPanelProps extends CheckPanelModel {
  open: boolean;
  anchor: HTMLElement | null;
  onClose: () => void;
}

/** One issue. The row is a group named by its code and part, because rows repeat the same Go to control (D27). */
function IssueRow({ issue, severity, onGoTo }: { issue: CheckIssue; severity: "error" | "warning"; onGoTo: (target: RwRef) => void }) {
  const codeId = useId();
  const whereId = useId();
  const { target, goTo } = issue;
  return (
    <div className="rw-check-issues__row" role="group" aria-labelledby={`${codeId} ${whereId}`} data-severity={severity} data-testid="header.check-issue">
      <span className="rw-check-issues__mark">
        <Icon name={severity === "error" ? "error-disc" : "alert-solid"} size={20} label={severity === "error" ? "Error" : "Warning"} />
      </span>
      <span id={codeId} className="rw-check-issues__code">
        {issue.code}
      </span>
      <span className="rw-check-issues__message">
        <DiagnosticText text={issue.message} />
      </span>
      <span id={whereId} className="rw-check-issues__part">
        {issue.where ?? "Whole model"}
      </span>
      {target === null || goTo === null ? (
        <span className="rw-check-issues__no-link" title="Nothing in the model to open for this issue">
          No link
        </span>
      ) : (
        <button type="button" className="rw-check-issues__goto" onClick={() => onGoTo(target)}>
          {goTo}
        </button>
      )}
    </div>
  );
}

function IssueGroup({ title, severity, issues, onGoTo }: { title: string; severity: "error" | "warning"; issues: readonly CheckIssue[]; onGoTo: (target: RwRef) => void }) {
  const headingId = useId();
  if (issues.length === 0) return null;
  return (
    <section className="rw-check-issues__group" role="group" aria-labelledby={headingId}>
      <h3 id={headingId} className="rw-check-issues__heading">
        {title}
      </h3>
      {issues.map((issue) => (
        <IssueRow key={issue.key} issue={issue} severity={severity} onGoTo={onGoTo} />
      ))}
    </section>
  );
}

function emptyNote(checked: boolean, running: boolean, failed: boolean): string | null {
  if (running) return "Checking model…";
  if (failed) return null;
  return checked ? "No errors or warnings." : "Model not checked yet.";
}

export function CheckIssuesPanel({ open, anchor, onClose, issues, checked, running, error, onRunAgain, onGoTo }: CheckIssuesPanelProps) {
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
        <IssueGroup title="Errors" severity="error" issues={errors} onGoTo={onGoTo} />
        <IssueGroup title="Warnings" severity="warning" issues={warnings} onGoTo={onGoTo} />
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
