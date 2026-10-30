/**
 * Payload types referenced by the hand-written contracts (rpc.ts, broker.ts).
 * Each name equals a generated type in `./generated/types.ts`
 * (json-schema-to-typescript over `schema/`, written by `scripts/gen.ts`),
 * which in turn comes from a registry entry in `rw_api::schema_registry()`
 * (invariant I3). M1.6 replaced the M1.5 placeholder aliases with these
 * re-exports, keeping the names, so importers did not change.
 */

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** The JSON contract version (D19c). */
export const SCHEMA_VERSION = "rw/1" as const;

export type {
  /** schema/api-error.json. */
  ApiError,
  /** schema/check-delta.json (IF7). */
  CheckDelta,
  /** schema/check-report.json (IF7). */
  CheckReport,
  /** schema/tools/history_compare.output.json. */
  CompareOut,
  /** A visual-diff mark of one component (`CompareOut.marks`, M2.7). */
  ComponentMark,
  /** schema/tools/model_get.output.json. */
  ModelGetOut,
  /** schema/evaluated-model.json (IF2). */
  EvaluatedModel,
  /** schema/tools/history_list.output.json (`rw://project/history`). */
  HistoryListOut,
  /** schema/history-step.json. */
  HistoryStep,
  /** schema/job-info.json. */
  JobInfo,
  /** schema/tools/model_patch.output.json and every mutating tool. */
  MutationOut,
  /** schema/patch-op.json (RFC 6902 on id paths). */
  PatchOp,
  /** schema/project-files.json. */
  ProjectFiles,
  /** schema/render-result.json. */
  RenderResult,
  /** schema/tools/history_tag.output.json. */
  Revision,
  /** schema/tools/run_list.output.json (`rw://runs/index`). */
  RunListOut,
  RunStatus,
  /** `rw:<kind>/<id>[#anchor][@version][/pointer]` (R2.8). */
  RwRef,
  /** schema/tools/simulate.output.json. */
  SimulateOut,
} from "./generated/types.ts";
