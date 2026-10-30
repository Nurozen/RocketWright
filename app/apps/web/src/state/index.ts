/** Web state (M1.48): the app store, RPC client, WASM loader, and status vocabulary. */
export * from "./types.ts";
export * from "./store.ts";
export * from "./selectors.ts";
export * from "./status.ts";
export * from "./wasm.ts";
export * from "./rpc.ts";
export { coalesce } from "./slices/draft.ts";
export { componentRef, parseRef, REF_KINDS, type ParsedRef, type RefKind } from "./slices/selection.ts";
export { deepFreeze } from "./slices/project.ts";
