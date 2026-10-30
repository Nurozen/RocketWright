import { defineConfig } from "vitest/config";

// Unit tests only; GPU tests need a logged-in GUI session (`pnpm test:gpu`).
// `@lecturn/embed` is inlined so `vi.mock("electron")` reaches the vendored
// helper (test/lecturnView.test.ts drives the real `mountEmbedView`).
export default defineConfig({
  test: { include: ["src/**/*.test.ts", "test/**/*.test.ts"], exclude: ["**/*.gpu.test.ts"], server: { deps: { inline: [/@lecturn\/embed/] } } },
});
