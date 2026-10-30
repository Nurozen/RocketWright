import { defineConfig } from "vitest/config";

// `pnpm --dir app e2e:desktop [page04]` (`make e2e`): vitest page specs in the desktop hidden window on the live
// sidecar over the seeded research vehicle (GUI session). The Playwright specs are listed in playwright.config.ts.
export default defineConfig({
  test: { include: ["e2e/page04.spec.ts"], testTimeout: 30_000, hookTimeout: 400_000, fileParallelism: false },
});
