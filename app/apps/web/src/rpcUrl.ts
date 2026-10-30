/**
 * The page's RPC socket URL (REV-srv). The server refuses the upgrade without
 * its per-launch token (`?token=` on the socket URL, `RPC_TOKEN_PARAM`):
 *
 * - browser mode: the page query has `rpc=` without the token, and the token
 *   sits in the URL fragment (`#token=…`, never sent to a server);
 * - desktop: the preload's `rwDesktop.rpcUrl` carries it;
 * - drivers and e2e may pass a `rpc=` that already carries it.
 *
 * Precedence of the base URL: query `rpc`, then the desktop's, then the env's.
 */
import { RPC_TOKEN_PARAM } from "@rw/contracts";

export interface PageRpcInput {
  search: string;
  hash: string;
  desktopUrl?: string | null | undefined;
  envUrl?: string | null | undefined;
}

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

export function pageRpcUrl(o: PageRpcInput): string | null {
  const base = new URLSearchParams(o.search).get("rpc") ?? o.desktopUrl ?? o.envUrl ?? null;
  if (base === null || base === "") return null;
  const u = parse(base);
  if (u === null) return base;
  if ((u.searchParams.get(RPC_TOKEN_PARAM) ?? "") !== "") return base;
  let token = new URLSearchParams(o.hash.replace(/^#/, "")).get(RPC_TOKEN_PARAM);
  if ((token ?? "") === "" && o.desktopUrl) {
    // Only for the same server: the desktop's secret never goes to another one.
    const d = parse(o.desktopUrl);
    if (d !== null && d.host === u.host && d.pathname === u.pathname) token = d.searchParams.get(RPC_TOKEN_PARAM);
  }
  if (token === null || token === "") return base;
  u.searchParams.set(RPC_TOKEN_PARAM, token);
  return u.toString();
}
