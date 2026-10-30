/** RPC failures (IF10 `RpcError`) raised by handlers and the project layer. */
import type { ApiError, RpcError } from "@rw/contracts";
import { SidecarUnavailable } from "../sidecar/SidecarSupervisor.ts";

export class RpcFail extends Error {
  readonly code: RpcError["code"];
  readonly api: ApiError | undefined;

  constructor(code: RpcError["code"], message: string, api?: ApiError) {
    super(message);
    this.code = code;
    this.api = api;
  }

  toRpcError(): RpcError {
    const e: RpcError = { code: this.code, message: this.message };
    if (this.api !== undefined) e.api = this.api;
    return e;
  }
}

/** Any thrown value → an `RpcError`. */
export function toRpcError(e: unknown): RpcError {
  if (e instanceof RpcFail) return e.toRpcError();
  if (e instanceof SidecarUnavailable) return { code: "sidecar_unavailable", message: e.message };
  return { code: "internal", message: e instanceof Error ? e.message : String(e) };
}
