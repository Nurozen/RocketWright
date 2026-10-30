import { defineConfig } from "vitest/config";

// These suites drive the real sidecar and sim jobs over WS RPC; under a loaded
// `make check` the 5 s default timed out on calls that pass in under a second.
export default defineConfig({
  test: { testTimeout: 30_000 },
});
