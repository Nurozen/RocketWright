/**
 * B5 manual check, on the real embed since B10 (needs a GUI session and the
 * vendored Lecturn; builders never run it): can Playwright reach the Lecturn
 * pane's `WebContentsView`? Playwright documents `windows()` for
 * BrowserWindows only [R:app.x Playwright Electron], so this launches the
 * desktop app on a dev project (`--dev-project`) and
 * tries, in order:
 *
 * 1. `_electron.launch` then `context().pages()` filtered by the embed's
 *    `/embed/` guest URL;
 * 2. a plain Electron spawn with `--remote-debugging-port` and
 *    `chromium.connectOverCDP`, then the same filter over every context.
 *
 * Prints `{ reached: [{ via, url, text }] , errors }` and exits 0 when at
 * least one method reached the guest. `LECTURN_HOME` and
 * `RW_LECTURN_BASE_DIR` are fresh temp dirs (removed after), so nothing
 * touches ~/.lecturn.
 *
 *   env -u ELECTRON_RUN_AS_NODE node app/e2e/capture/lecturn-reach.ts
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, chromium, type Page } from "@playwright/test";

const DESKTOP = resolve(import.meta.dirname, "../../apps/desktop");
const MAIN = join(DESKTOP, "src/main.ts");
const SPIKE_ARGS = [MAIN, "-ApplePersistenceIgnoreState", "YES", "--dev-project", "--page", "01"];
const TEMPS = [mkdtempSync(join(tmpdir(), "rw-reach-home-")), mkdtempSync(join(tmpdir(), "rw-reach-base-")), mkdtempSync(join(tmpdir(), "rw-reach-electron-"))];
const PORT = Number(process.env["RW_REACH_PORT"] ?? 9339);
const executablePath = createRequire(join(DESKTOP, "package.json"))("electron") as string;

interface Reach {
  via: string;
  url: string;
  text: string;
}

const env = (): Record<string, string> => {
  const e: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "ELECTRON_RUN_AS_NODE") e[k] = v;
  return { ...e, LECTURN_HOME: TEMPS[0]!, RW_LECTURN_BASE_DIR: TEMPS[1]!, RW_USER_DATA_DIR: TEMPS[2]! };
};

async function findSpike(pages: () => Page[], via: string, timeoutMs = 90_000): Promise<Reach | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const p of pages()) {
      const url = new URL(p.url(), "http://x/");
      if (!url.pathname.startsWith("/embed/")) continue;
      const text = (await p.title().catch(() => "")) || ((await p.locator("body").innerText().catch(() => "")) ?? "").slice(0, 60);
      if (text !== "") return { via, url: `${url.origin}${url.pathname}`, text };
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

async function viaElectron(): Promise<Reach | null> {
  const app = await electron.launch({ executablePath, args: SPIKE_ARGS, env: env(), timeout: 60_000 });
  try {
    await app.firstWindow();
    return await findSpike(() => app.context().pages(), "_electron context().pages()");
  } finally {
    await app.close();
  }
}

async function viaCdp(): Promise<Reach | null> {
  const child = spawn(executablePath, [`--remote-debugging-port=${PORT}`, ...SPIKE_ARGS], { env: env(), stdio: "ignore" });
  try {
    const deadline = Date.now() + 60_000;
    for (;;) {
      try {
        const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
        try {
          return await findSpike(() => browser.contexts().flatMap((c) => c.pages()), "connectOverCDP");
        } finally {
          await browser.close();
        }
      } catch (e) {
        if (Date.now() > deadline) throw e;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  } finally {
    child.kill("SIGTERM");
  }
}

const reached: Reach[] = [];
const errors: string[] = [];
for (const [name, method] of [
  ["electron", viaElectron],
  ["cdp", viaCdp],
] as const) {
  try {
    const r = await method();
    if (r !== null) reached.push(r);
    else errors.push(`${name}: the embed guest never appeared`);
  } catch (e) {
    errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
for (const d of TEMPS) rmSync(d, { recursive: true, force: true });
process.stdout.write(`${JSON.stringify({ reached, errors }, null, 2)}\n`);
process.exit(reached.length > 0 ? 0 : 1);
