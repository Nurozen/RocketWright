/**
 * Keeps the part thumbnails of the committed model current (M3.6): on each
 * model hash it reads the server cache (`thumb.get`), renders what is
 * missing in an offscreen renderer (`bakeThumbnails`), and stores those back
 * (`thumb.put`). Mounted once in the live shell, so every page's tree and
 * chips get thumbnails, not only Assembly. Renders a hidden status element
 * (`thumbs.status`: `loading`, `baking`, `ready`, `unavailable`) for tests
 * and captures.
 */
import { useEffect, useState } from "react";
import type { EvaluatedModel } from "@rw/contracts";
import { useAppState, type AppStore } from "../state/index.ts";
import type { GlbDeps } from "../viewport/glb-source.ts";
import { bakeKeys, bakeThumbnails } from "./thumbnails.ts";

type Phase = "idle" | "loading" | "baking" | "ready" | "unavailable";

/** Lets the visible page's own renderer start first. */
const BAKE_DELAY_MS = 200;

export function ThumbnailBaker({ store, glbDeps }: { store: AppStore; glbDeps: GlbDeps }) {
  const evaluated = useAppState(store, (s) => s.project.snapshot?.evaluated ?? null);
  const projectId = useAppState(store, (s) => s.project.projectId);
  const urls = useAppState(store, (s) => s.thumbs.urls);
  const rendered = useAppState(store, (s) => s.thumbs.rendered.length);
  const [phase, setPhase] = useState<Phase>("idle");
  const hash = evaluated?.model_hash ?? null;

  useEffect(() => {
    if (evaluated === null || hash === null || projectId === null) return;
    let cancelled = false;
    void (async () => {
      setPhase("loading");
      await store.getState().thumbs.load(hash);
      if (cancelled) return;
      const have = store.getState().thumbs.urls;
      const missing = bakeKeys(evaluated.components.map((c) => c.id)).filter((k) => !(k in have));
      if (missing.length === 0) {
        setPhase("ready");
        return;
      }
      await new Promise((r) => setTimeout(r, BAKE_DELAY_MS));
      if (cancelled) return;
      setPhase("baking");
      const done = await bakeThumbnails(evaluated as EvaluatedModel, glbDeps, missing, (key, png) => void store.getState().thumbs.add(hash, key, png), () => cancelled);
      if (!cancelled) setPhase(done.length === 0 ? "unavailable" : "ready");
    })().catch((e: unknown) => {
      if (cancelled) return;
      console.warn("thumbnails:", e);
      setPhase("unavailable");
    });
    return () => {
      cancelled = true;
    };
    // The model hash identifies the model; the object itself changes on every snapshot push.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hash, projectId, glbDeps, store]);

  const count = Object.keys(urls).length;
  return <span hidden data-testid="thumbs.status" data-state={phase} data-hash={hash ?? ""} data-count={count} data-rendered={rendered} />;
}
