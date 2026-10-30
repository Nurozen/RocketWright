/**
 * Bearers for the app server's MCP route (B9): the live tools route's one
 * static per-launch bearer, and the `Authorization` header parser.
 *
 * B17 removed the old chat's per-thread credential registry (the HTTP MCP's
 * thread scopes); Lecturn now runs every turn and calls only `/mcp/live`.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The live route's single static bearer (B9): one per server launch, handed
 * to Lecturn with `setLiveTools({url, bearer})`. Only its sha256 is compared
 * (timing-safe); the raw token is
 * kept only to publish it. It never changes while the server runs, so a live
 * switch (D25) moves the lease without a new bearer.
 */
export class LiveToolsBearer {
  readonly token: string;
  private readonly hash: Buffer;

  constructor(token: string = randomBytes(32).toString("base64url")) {
    if (token.length === 0) throw new Error("live-tools bearer must not be empty");
    this.token = token;
    this.hash = createHash("sha256").update(token).digest();
  }

  /** True for exactly this bearer (from an `Authorization` header, via `bearerToken`). */
  verify(token: string): boolean {
    if (token.length === 0) return false;
    return timingSafeEqual(createHash("sha256").update(token).digest(), this.hash);
  }
}

/** Extracts the token from an `Authorization: Bearer <token>` header. */
export function bearerToken(header: string | string[] | undefined): string {
  const h = Array.isArray(header) ? header[0] : header;
  if (h === undefined) return "";
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m?.[1]?.trim() ?? "";
}
