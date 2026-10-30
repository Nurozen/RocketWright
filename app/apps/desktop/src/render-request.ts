/**
 * The stdin side of `rocketwright-render` (`render-main.ts`): the fields of
 * the IF8 `RenderRequest` the Electron main reads before handing the whole
 * request to the page. Pure, so it unit-tests without Electron.
 */

/** The request fields this process reads (the page validates the rest). */
export interface JobRequest {
  view: string;
  width: number;
  height: number;
  [k: string]: unknown;
}

/** Parses the stdin request; throws with a readable message. */
export function parseRequest(text: string): JobRequest {
  if (text.trim() === "") throw new Error("no RenderRequest on stdin");
  const v = JSON.parse(text) as Partial<JobRequest> | null;
  if (v === null || typeof v !== "object") throw new Error("the RenderRequest is not a JSON object");
  if (typeof v.view !== "string") throw new Error("RenderRequest.view is missing");
  for (const k of ["width", "height"] as const) {
    const n = v[k];
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 8192) throw new Error(`RenderRequest.${k} must be 1..8192`);
  }
  if (typeof v.evaluated !== "object" || v.evaluated === null) throw new Error("RenderRequest.evaluated is missing");
  return v as JobRequest;
}
