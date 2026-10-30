/**
 * Static server for the built web bundle on http://127.0.0.1:<port 0>.
 * WASM must not load from file:// (plan, Environment pitfalls).
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize, sep } from "node:path";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".glb": "model/gltf-binary",
};

export interface StaticServer {
  origin: string;
  close(): Promise<void>;
}

/** Maps a URL path to a file under `root`, or null if it escapes `root`. */
export function resolveUnder(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath.split("?")[0] ?? "/");
  } catch {
    return null;
  }
  const rel = normalize(decoded === "/" ? "/index.html" : decoded).replace(/^[/\\]+/, "");
  const file = join(root, rel);
  const base = root.endsWith(sep) ? root : root + sep;
  return file.startsWith(base) ? file : null;
}

export async function serveStatic(root: string): Promise<StaticServer> {
  const server: Server = createServer((req, res) => {
    const file = resolveUnder(root, req.url ?? "/");
    if (!file) {
      res.writeHead(403).end();
      return;
    }
    stat(file).then(
      (s) => {
        if (!s.isFile()) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, {
          "content-type": MIME[extname(file)] ?? "application/octet-stream",
          "content-length": s.size,
          "cache-control": "no-store",
        });
        createReadStream(file).pipe(res);
      },
      () => res.writeHead(404).end(),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((r) => {
        server.close(() => r());
        server.closeAllConnections();
      }),
  };
}
