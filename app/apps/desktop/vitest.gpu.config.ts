import { defineConfig } from "vitest/config";

// `pnpm --filter desktop test:gpu`: hidden Electron window + WebGPU (I11).
export default defineConfig({
  test: { include: ["src/**/*.gpu.test.ts"], testTimeout: 120_000, hookTimeout: 120_000 },
});
