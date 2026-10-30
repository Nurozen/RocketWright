/**
 * Playwright e2e (`make e2e`, `make check` stage 3, M1.18; `pnpm -C app e2e
 * [spec]`). Specs are `app/e2e/*.spec.ts`, in two projects:
 * - `electron`: specs that drive the Electron app via `_electron` (b4a.spec.ts);
 *   no browser download is needed.
 * - `web`: specs on the web bundle against the live server (page01.spec.ts,
 *   M1.50; page02/page03.spec.ts, M2.9/M2.10). The global setup builds the web app, serves it
 *   with `vite preview`, and starts the mock, both on port 0; their URLs reach
 *   the specs through RW_E2E_WEB_URL and RW_E2E_RPC_URL.
 * The JSON report lands at `e2eReportPath()`, which `make bar`
 * (scripts/bar/scoreboard.ts) reads for the B4(a) row. `page04.spec.ts`
 * (M1.51) runs on the desktop --measure harness via vitest, not here.
 */
import { defineConfig } from "@playwright/test";
import { join } from "node:path";
import { e2eReportPath, REPO_ROOT } from "./bar/paths.ts";

const ELECTRON_SPECS = /b4a\.spec\.ts$/;
/** Project-level `testIgnore` replaces the top-level one, so each project repeats it. */
const IGNORE = ["**/node_modules/**", "**/__tests__/**", "**/page04.spec.ts"];

export default defineConfig({
  testDir: ".",
  testMatch: /\.spec\.ts$/,
  testIgnore: IGNORE,
  globalSetup: "./global-setup.ts",
  outputDir: join(REPO_ROOT, ".playwright/test-results"),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 120_000,
  expect: { timeout: 30_000 },
  reporter: [["list"], ["json", { outputFile: e2eReportPath() }]],
  use: { trace: "retain-on-failure" },
  projects: [
    { name: "electron", testMatch: ELECTRON_SPECS, testIgnore: IGNORE },
    {
      name: "web",
      testIgnore: [...IGNORE, ELECTRON_SPECS],
      timeout: 90_000,
      expect: { timeout: 10_000 },
      use: {
        // New headless Chromium with the GPU enabled renders through WebGPU where an
        // adapter exists; elsewhere three falls back to WebGL2 and the specs still run.
        channel: "chromium",
        launchOptions: { args: ["--enable-unsafe-webgpu", "--enable-gpu", "--ignore-gpu-blocklist"] },
        viewport: { width: 1536, height: 1024 },
        deviceScaleFactor: 1,
        colorScheme: "dark",
        trace: "retain-on-failure",
      },
    },
  ],
});
