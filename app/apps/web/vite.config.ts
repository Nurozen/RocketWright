import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const here = import.meta.dirname;

// Served over http://127.0.0.1 (never file://) so the wasm glue can fetch
// rw_wasm_bg.wasm; base "./" keeps asset URLs relative for app:// later.
// `spikes/*.html` are the RL1 visual spikes (docs/dev/spikes.md), separate
// entries so the app bundle never loads the path tracer or manifold-3d.
export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    target: "esnext",
    outDir: "dist",
    emptyOutDir: true,
    chunkSizeWarningLimit: 2048,
    rollupOptions: {
      input: {
        main: resolve(here, "index.html"),
        "spike-transmission": resolve(here, "spikes/transmission.html"),
        "spike-pathtrace": resolve(here, "spikes/pathtrace.html"),
        "spike-section": resolve(here, "spikes/section.html"),
      },
    },
  },
  optimizeDeps: { exclude: ["@rw/rw-wasm", "manifold-3d"] },
  server: { host: "127.0.0.1" },
});
