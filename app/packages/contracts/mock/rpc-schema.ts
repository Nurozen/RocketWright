/**
 * JSON Schemas for the IF10 frames in `src/rpc.ts` (results, pushes, hello,
 * errors). Payload types that come from Rust point at their registry schema
 * (`$id` = `https://rocketwright.dev/schema/1/<name>.json`); IF10-only shapes
 * (ProjectInfo, EmbedThread, LecturnStatus, ...) are spelled out here. Must
 * track `rpc.ts`: the mock tests validate every frame against these.
 */
import type { JsonValue } from "../src/types.ts";
import { AGENT_OPS, TEST_HOOK_OPS } from "../src/broker.ts";
import type { RpcMethod, RpcTopic } from "../src/rpc.ts";
import { RPC_VERSION } from "../src/rpc.ts";
import type { Schema } from "./jsonschema.ts";

export const SCHEMA_ID_BASE = "https://rocketwright.dev/schema/1/";
export const RPC_SCHEMA_ID = `${SCHEMA_ID_BASE}rpc/if10.json`;

type S = { [k: string]: JsonValue };

/** A `$ref` to a registry schema (`check-report`, `tools/model_patch.output`). */
export const reg = (name: string): S => ({ $ref: `${SCHEMA_ID_BASE}${name}.json` });
const def = (name: string): S => ({ $ref: `#/$defs/${name}` });
const str: S = { type: "string" };
const obj = (properties: { [k: string]: S }, required: string[] = Object.keys(properties)): S => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const empty: S = obj({});
const json: S = {};
const jsonObject: S = { type: "object" };
const constant = (c: string): S => ({ const: c });


const snapshotProps: { [k: string]: S } = {
  sidecar: obj({ state: { enum: ["starting", "ready", "restarting", "failed"] }, version: { type: ["string", "null"] } }),
  evaluated: { anyOf: [{ type: "null" }, reg("evaluated-model")] },
  check: { anyOf: [{ type: "null" }, reg("check-report")] },
  files: reg("project-files"),
  history: reg("tools/history_list.output"),
  runs: reg("tools/run_list.output"),
  jobs: { type: "array", items: reg("job-info") },
};

const $defs: { [k: string]: S } = {
  ProjectInfo: obj({ projectId: str, dir: str, name: str }),
  ProjectSnapshot: obj({ project: def("ProjectInfo"), ...snapshotProps }),
  ProjectPatch: obj({ projectId: str, ...snapshotProps }, ["projectId"]),
  JobInfo: reg("job-info"),
  EmbedTarget: obj({ url: str, token: str, expiresAt: str }),
  EmbedThread: obj(
    {
      threadId: str,
      projectId: str,
      workspaceRoot: str,
      title: str,
      createdAt: str,
      updatedAt: str,
      historyRevision: { type: "integer" },
      state: { enum: ["idle", "running", "awaiting-approval"] },
      appData: { type: ["string", "null"] },
      subtitle: { type: ["string", "null"] },
      copiedFrom: obj({ appId: str, sourceEnvironmentId: str, sourceThreadId: str, copiedAt: str, sourceHistoryRevision: { type: "integer" } }),
      continuedIn: obj({ environmentId: str, threadId: str, copiedAt: str }),
    },
    ["threadId", "projectId", "workspaceRoot", "title", "createdAt", "updatedAt", "historyRevision", "state", "appData", "subtitle"],
  ),
  LecturnStatus: obj(
    {
      state: { enum: ["connecting", "connected", "unavailable"] },
      mode: { enum: ["sidecar", "user-server", null] },
      pairing: { enum: ["none", "pending", "denied"] },
      message: str,
      switched: obj({
        environmentId: str,
        projects: { type: "object", additionalProperties: str },
        threadIdMap: { type: "object", additionalProperties: str },
      }),
    },
    ["state", "mode", "pairing"],
  ),
  RpcError: obj(
    {
      code: { enum: ["not_found", "invalid_params", "sidecar_unavailable", "version_mismatch", "hooks_disabled", "api_error", "internal"] },
      message: str,
      api: reg("api-error"),
    },
    ["code", "message"],
  ),
  BrokerRequest: obj({
    requestId: str,
    projectId: str,
    threadId: { type: ["string", "null"] },
    op: { enum: [...AGENT_OPS, ...TEST_HOOK_OPS] },
    args: jsonObject,
  }),
};

/** Result schema per method (must match `RpcMethods` in rpc.ts). */
export const RESULT_SCHEMAS: { [M in RpcMethod]: S } = {
  "project.list": obj({ projects: { type: "array", items: def("ProjectInfo") } }),
  "project.open": obj({ project: def("ProjectInfo") }),
  "project.close": empty,
  "project.subscribe": obj({ subscriptionId: str, snapshot: def("ProjectSnapshot") }),
  "project.unsubscribe": empty,
  "model.patch": reg("tools/model_patch.output"),
  "model.get": reg("tools/model_get.output"),
  "check.run": reg("check-report"),
  "sim.run": reg("tools/simulate.output"),
  "job.cancel": reg("job-info"),
  "history.compare": reg("tools/history_compare.output"),
  "history.tag": reg("tools/history_tag.output"),
  "history.restore": reg("tools/history_restore.output"),
  "library.search": reg("tools/library_search.output"),
  "thumb.get": obj({ thumbs: { type: "object", additionalProperties: str } }),
  "thumb.put": empty,
  "engine.design": reg("tools/engine_design.output"),
  "engine.simulate": reg("tools/engine_simulate.output"),
  "cfd.import": reg("tools/cfd_import.output"),
  "cfd.list": obj({ datasets: { type: "array", items: jsonObject } }),
  "broker.hostRegister": empty,
  "broker.respond": empty,
  "embed.target": def("EmbedTarget"),
  "embed.refreshToken": def("EmbedTarget"),
  "embed.setThreadAppData": empty,
  "embed.setHostContext": obj({ applied: { type: "boolean" } }),
  "test.call": jsonObject,
};

/** Push payload schema per topic (must match `RpcTopics`). */
export const TOPIC_SCHEMAS: { [T in RpcTopic]: S } = {
  "project.opened": obj({ project: def("ProjectInfo") }),
  "project.snapshot": obj({ subscriptionId: str, snapshot: def("ProjectSnapshot") }),
  "project.patch": obj({ subscriptionId: str, patch: def("ProjectPatch") }),
  "broker.request": def("BrokerRequest"),
  "embed.threads": obj({ projectId: str, threads: { type: "array", items: def("EmbedThread") } }),
  "lecturn.status": def("LecturnStatus"),
};

const frameBranches: S[] = [
  obj({ kind: constant("hello"), rpc: constant(RPC_VERSION), schema: constant("rw/1"), coreVersion: str, testHooks: { type: "boolean" } }),
  obj({ kind: constant("response"), id: { type: "integer" }, ok: { const: false }, error: def("RpcError") }),
  // Successful responses are checked per method (the frame does not name it).
  obj({ kind: constant("response"), id: { type: "integer" }, ok: { const: true }, result: json }),
  ...(Object.keys(TOPIC_SCHEMAS) as RpcTopic[]).map((t) => obj({ kind: constant("push"), topic: constant(t), payload: TOPIC_SCHEMAS[t] })),
];

/** One root holding every IF10 definition; refer to parts with `#/$defs/...`. */
export const RPC_SCHEMA: Schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: RPC_SCHEMA_ID,
  $defs: {
    ...$defs,
    ServerFrame: { oneOf: frameBranches },
    ...Object.fromEntries(Object.entries(RESULT_SCHEMAS).map(([m, s]) => [`result:${m}`, s])),
  },
};

/** `$ref` ids into RPC_SCHEMA. */
export const resultRef = (m: RpcMethod): string => `${RPC_SCHEMA_ID}#/$defs/result:${m}`;
export const SERVER_FRAME_REF = `${RPC_SCHEMA_ID}#/$defs/ServerFrame`;
