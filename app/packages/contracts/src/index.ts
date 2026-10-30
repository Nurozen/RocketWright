/** Shared contracts: generated types from schema/, WebSocket RPC (IF10), broker ops (IF11), and the mock RPC server. */
export const PACKAGE_NAME = "@rw/contracts";

export * from "./types.ts";
export * from "./rpc.ts";
export * from "./broker.ts";
export * from "./refs.ts";
export * from "./patch.ts";
export * from "./embedPane.ts";
/** Every generated schema type (`schema.RocketDoc`, `schema.Command`, ...). */
export type * as schema from "./generated/types.ts";
export * from "./generated/schema-meta.ts";
