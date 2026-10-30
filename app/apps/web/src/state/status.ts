/**
 * The status vocabulary (concepts C §5.2): one function maps runs, jobs,
 * checks, drafts, and components to a fixed label, icon, and tone. Status
 * is always computed from the current model hash, never trusted as stored
 * (I7). Rule: green is never used for unvalidated work; success is a teal
 * check, and anything that cannot be proven current is amber.
 */
import type { CheckReport, JobInfo, PatchOp, RunListOut, schema } from "@rw/contracts";

type Diagnostic = schema.Diagnostic;

type RunListEntry = RunListOut["runs"][number];

export type StatusKind =
  | "complete"
  | "outdated"
  | "not_run"
  | "queued"
  | "running"
  | "failed"
  | "cancelled"
  | "modified"
  | "missing_inputs"
  | "errors"
  | "warnings"
  | "checked"
  | "unchecked"
  | "saved";

export type StatusIcon = "check" | "warning" | "dot" | "circle" | "spinner" | "error" | "cloud";
/** Deliberately no `green`/`success` tone (C §2 forbidden list). */
export type StatusTone = "teal" | "amber" | "muted" | "danger";

/** Colour per tone (C §2 tokens: accent/teal, warning, text/secondary). */
export const STATUS_TONE_COLOR: Readonly<Record<StatusTone, string>> = Object.freeze({
  teal: "#61b5ad",
  amber: "#fac95e",
  muted: "#8e989c",
  danger: "#e5735c",
});

export interface StatusView {
  kind: StatusKind;
  label: string;
  icon: StatusIcon;
  tone: StatusTone;
  /** `Missing inputs · N`, error and warning counts. */
  count?: number;
  /** 0..1 for queued or running jobs. */
  progress?: number;
  /** One line explaining a non-obvious status (tooltips; e.g. why a run is Outdated). */
  reason?: string;
}

export type StatusSubject =
  /** A Runs-table row: `run` is the `rw://runs/index` entry, `job` the live job for its sim if any. */
  | { kind: "run"; run: RunListEntry | null | undefined; modelHash: string | null | undefined; job?: JobInfo | null }
  | { kind: "job"; job: JobInfo }
  /** The header `Check model` state. */
  | { kind: "check"; report: CheckReport | null | undefined; modelHash: string | null | undefined }
  /** Missing-inputs badge over a diagnostic list (liquid W200-249). */
  | { kind: "inputs"; diagnostics: readonly Diagnostic[] }
  /** Unsaved UI edits. */
  | { kind: "draft"; ops: readonly PatchOp[] }
  /** One component: Modified when a draft op touches `/c/<id>`. */
  | { kind: "component"; id: string; ops: readonly PatchOp[] };

const S = {
  complete: { kind: "complete", label: "Complete", icon: "check", tone: "teal" },
  outdated: { kind: "outdated", label: "Outdated", icon: "warning", tone: "amber" },
  not_run: { kind: "not_run", label: "Not run", icon: "circle", tone: "muted" },
  queued: { kind: "queued", label: "Queued", icon: "spinner", tone: "muted" },
  running: { kind: "running", label: "Running", icon: "spinner", tone: "muted" },
  failed: { kind: "failed", label: "Failed", icon: "error", tone: "danger" },
  cancelled: { kind: "cancelled", label: "Cancelled", icon: "circle", tone: "muted" },
  modified: { kind: "modified", label: "Modified", icon: "dot", tone: "amber" },
  checked: { kind: "checked", label: "Checked", icon: "check", tone: "teal" },
  unchecked: { kind: "unchecked", label: "Not checked", icon: "circle", tone: "muted" },
  /** Saved is not validated: muted, never a check. */
  saved: { kind: "saved", label: "Saved", icon: "cloud", tone: "muted" },
} as const satisfies Record<string, StatusView>;

const view = (base: StatusView, extra: Partial<StatusView> = {}): StatusView => ({ ...base, ...extra });

/** Liquid missing-input diagnostics: `RW-W200`..`RW-W249` (I9). */
export function isMissingInput(d: Pick<Diagnostic, "code">): boolean {
  const m = /^RW-W(\d{3})$/.exec(d.code);
  return m !== null && Number(m[1]) >= 200 && Number(m[1]) <= 249;
}

/** True when a patch op reads or writes component `id`. */
export function opTouchesComponent(op: PatchOp, id: string): boolean {
  const prefix = `/c/${id}`;
  const hits = (p: string): boolean => p === prefix || p.startsWith(`${prefix}/`);
  return hits(op.path) || ("from" in op && hits(op.from));
}

function ofJob(job: JobInfo): StatusView | null {
  switch (job.state) {
    case "queued":
      return view(S.queued, { progress: job.progress });
    case "running":
      return view(S.running, { label: `Running ${Math.round(job.progress * 100)}%`, progress: job.progress });
    case "failed":
      return view(S.failed, job.error ? { reason: job.error } : {});
    case "cancelled":
      return view(S.cancelled);
    case "complete":
      return null;
  }
}

function ofRun(run: RunListEntry | null | undefined, modelHash: string | null | undefined, job: JobInfo | null | undefined): StatusView {
  if (job !== null && job !== undefined && (job.state === "queued" || job.state === "running")) return ofJob(job)!;
  if (run === null || run === undefined) return view(S.not_run);
  switch (run.status) {
    case "not_run":
      return view(S.not_run);
    case "running":
      return view(S.running);
    case "failed":
      return view(S.failed);
    case "complete":
    case "outdated": {
      // Computed, never stored (I7): only a run on the current model hash is Complete.
      if (run.run_id == null || run.model_hash == null) return view(S.outdated, { reason: "The run has no recorded model revision." });
      if (modelHash == null) return view(S.outdated, { reason: "The current model revision is unknown." });
      if (run.model_hash !== modelHash) return view(S.outdated, { reason: `${run.sim_name} uses an outdated model. Rebuild to run this simulation.` });
      return view(S.complete);
    }
  }
}

function ofInputs(diagnostics: readonly Diagnostic[]): StatusView | null {
  const n = diagnostics.filter(isMissingInput).length;
  return n === 0 ? null : { kind: "missing_inputs", label: `Missing inputs · ${n}`, icon: "warning", tone: "amber", count: n };
}

function ofCheck(report: CheckReport | null | undefined, modelHash: string | null | undefined): StatusView {
  if (report === null || report === undefined) return view(S.unchecked);
  if (modelHash == null || report.model_hash !== modelHash) return view(S.outdated, { reason: "The check ran on an older model revision." });
  const errors = report.diagnostics.filter((d) => d.severity === "error").length;
  if (errors > 0) return { kind: "errors", label: errors === 1 ? "1 error" : `${errors} errors`, icon: "error", tone: "danger", count: errors };
  const missing = ofInputs(report.diagnostics);
  if (missing !== null) return missing;
  const warnings = report.diagnostics.filter((d) => d.severity === "warning").length;
  if (warnings > 0) return { kind: "warnings", label: warnings === 1 ? "1 warning" : `${warnings} warnings`, icon: "warning", tone: "amber", count: warnings };
  return view(S.checked);
}

/** Every status shown in the UI comes from here. */
export function statusOf(subject: StatusSubject): StatusView {
  switch (subject.kind) {
    case "run":
      return ofRun(subject.run, subject.modelHash, subject.job);
    case "job":
      return ofJob(subject.job) ?? view(S.complete);
    case "check":
      return ofCheck(subject.report, subject.modelHash);
    case "inputs":
      return ofInputs(subject.diagnostics) ?? view(S.checked);
    case "draft":
      return subject.ops.length > 0 ? view(S.modified) : view(S.saved);
    case "component":
      return subject.ops.some((op) => opTouchesComponent(op, subject.id)) ? view(S.modified) : view(S.saved);
  }
}
