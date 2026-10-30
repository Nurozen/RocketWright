/**
 * Shared plumbing for the M3 viewport specs (explode, section, still,
 * thumbnails): open page 01 on the live server (global setup) and call the
 * read-only `window.__rwViewport` probe by name.
 */
import { expect, type FrameLocator, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./bar/paths.ts";

export const WEB = process.env["RW_E2E_WEB_URL"] ?? "";
export const RPC = process.env["RW_E2E_RPC_URL"] ?? "";
export const HTTP = process.env["RW_E2E_HTTP_URL"] ?? "";
export const PROJECT = process.env["RW_E2E_PROJECT"] ?? "";

/** Where the M3 specs leave their artifacts (clip frames, stills) for review. */
export const ARTIFACT_DIR = join(REPO_ROOT, ".playwright/m3");

export const viewport = (page: Page) => page.getByTestId("viewport");
export const row = (page: Page, id: string) => page.locator(`[data-testid="rail.nav-row"][data-part="${id}"]`);
export const chip = (page: Page, name: string) => page.getByTestId("toolbar.view-chip").filter({ hasText: name });

/** Opens page 01 and waits for the live viewport; fails on page errors during load. */
export async function openAssembly(page: Page): Promise<void> {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${WEB}?rpc=${encodeURIComponent(RPC)}&http=${encodeURIComponent(HTTP)}&page=01`);
  await page.waitForFunction(() => (window as unknown as { __rwShell?: { status: string } }).__rwShell?.status !== undefined && ["ready", "error"].includes((window as unknown as { __rwShell: { status: string } }).__rwShell.status));
  expect(await page.evaluate(() => (window as unknown as { __rwShell?: unknown }).__rwShell)).toMatchObject({ status: "ready" });
  await expect(viewport(page)).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
  expect(errors).toEqual([]);
}

/** Calls `window.__rwViewport[name](...args)` in the page (awaits promises). */
export async function vp<T = unknown>(page: Page, name: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(
    async ([n, a]) => {
      const api = (window as unknown as { __rwViewport?: Record<string, (...x: unknown[]) => unknown> }).__rwViewport;
      if (!api || typeof api[n as string] !== "function") throw new Error(`__rwViewport.${String(n)} is not available`);
      return (await api[n as string]!(...(a as unknown[]))) as unknown;
    },
    [name, args] as const,
  ) as Promise<T>;
}

/** Two animation frames in the page (state reaches the engine, a frame renders). */
export async function frames(page: Page, n = 2): Promise<void> {
  await page.evaluate(async (k) => {
    for (let i = 0; i < k; i++) await new Promise((r) => requestAnimationFrame(() => r(null)));
  }, n);
}

/** Writes a base64 PNG under `ARTIFACT_DIR/<sub>/<name>`; returns the path. */
export function saveArtifact(sub: string, name: string, pngBase64: string): string {
  const dir = join(ARTIFACT_DIR, sub);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, Buffer.from(pngBase64, "base64"));
  return p;
}

/**
 * The plain-web agent pane's guest (the Lecturn embed's iframe, B10), with a
 * thread open and its composer showing: a project without threads gets one
 * from the rail's New thread (`lecturn/thread.new`). Mentions land in that
 * composer's chip strip (B12; B17 removed the old chat's composer).
 */
export async function paneComposer(page: Page, timeoutMs = 90_000): Promise<FrameLocator> {
  const guest = page.frameLocator('[data-testid="agent.embed"] iframe');
  const composer = guest.locator('[data-slot="composer-shell"]');
  await expect(guest.locator("main").first()).toBeVisible({ timeout: timeoutMs });
  if ((await composer.count()) === 0) await page.getByTestId("rail.new-thread").click();
  await expect(composer.first()).toBeVisible({ timeout: timeoutMs });
  return guest;
}
