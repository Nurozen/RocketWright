/**
 * "Render still" panel (M3.4): the viewport's path-traced still export.
 * Product feature only (never bar evidence, D26), labelled visual tier
 * (I13). Choose a sample count, render, preview, save the PNG. The render
 * runs in its own offscreen renderer (`render/still.ts`), so the live view
 * stays interactive; the panel's data attributes carry the result for tests.
 */
import { useEffect, useRef, useState } from "react";
import type { StillOutput, StillRequest } from "../render/still.ts";

export const STILL_SAMPLE_CHOICES = [16, 32, 64, 128] as const;
/** Served OIDN weights (optional; not bundled, RL1): when present the panel offers Denoise. */
export const OIDN_WEIGHTS_PATH = "oidn/rt_hdr_alb_nrm_small.tza";

type Phase = { kind: "idle" } | { kind: "rendering"; done: number; target: number } | { kind: "done"; out: StillOutput; url: string } | { kind: "error"; message: string };

export interface StillPanelProps {
  /** Size of the still (the viewport's, so the framing matches). */
  width: number;
  height: number;
  section: boolean;
  fileName: string;
  render(req: Omit<StillRequest, "section">): Promise<StillOutput>;
  onClose(): void;
}

export function StillPanel({ width, height, section, fileName, render, onClose }: StillPanelProps) {
  const [samples, setSamples] = useState<number>(32);
  const [denoise, setDenoise] = useState(false);
  const [oidn, setOidn] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    const url = new URL(OIDN_WEIGHTS_PATH, document.baseURI).href;
    fetch(url, { method: "HEAD" })
      // A dev server's SPA fallback answers 200 with index.html: require a non-HTML body.
      .then((r) => alive.current && r.ok && !(r.headers.get("content-type") ?? "").includes("text/html") && setOidn(url))
      .catch(() => undefined);
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => () => {
    if (phase.kind === "done") URL.revokeObjectURL(phase.url);
  }, [phase]);

  const start = () => {
    setPhase({ kind: "rendering", done: 0, target: samples });
    render({
      width,
      height,
      samples,
      oidnWeightsUrl: denoise ? oidn : null,
      onProgress: (done, target) => alive.current && setPhase({ kind: "rendering", done, target }),
    }).then(
      (out) => {
        if (!alive.current) return;
        const bytes = Uint8Array.from(atob(out.png_base64), (c) => c.charCodeAt(0));
        setPhase({ kind: "done", out, url: URL.createObjectURL(new Blob([bytes], { type: "image/png" })) });
      },
      (e: unknown) => alive.current && setPhase({ kind: "error", message: e instanceof Error ? e.message : String(e) }),
    );
  };

  const busy = phase.kind === "rendering";
  const done = phase.kind === "done" ? phase.out : null;
  return (
    <div
      className="rw-still"
      role="dialog"
      aria-label="Render still"
      data-testid="still.panel"
      data-state={phase.kind}
      data-provenance="visual"
      {...(done ? { "data-samples": String(done.samples.min), "data-noise": done.noise.toFixed(3), "data-denoised": String(done.denoised), "data-width": String(done.width), "data-height": String(done.height) } : {})}
      {...(done?.section ? { "data-section-manifold": String(done.section.manifold), "data-section-clip": String(done.section.clip) } : {})}
      {...(phase.kind === "error" ? { "data-error": phase.message } : {})}
    >
      <header className="rw-still__head">
        <span className="rw-still__title">Render still</span>
        <span className="rw-still__badge" title="Path traced for presentation; never an engineering result">Path traced · Visual only</span>
        <button type="button" className="rw-still__close" aria-label="Close" data-testid="still.close" onClick={onClose}>
          ×
        </button>
      </header>
      <div className="rw-still__controls">
        <label>
          Samples
          <select data-testid="still.samples" value={samples} disabled={busy} onChange={(e) => setSamples(Number(e.currentTarget.value))}>
            {STILL_SAMPLE_CHOICES.map((n) => (
              <option key={n} value={n}>
                {n} spp
              </option>
            ))}
          </select>
        </label>
        {oidn !== null && (
          <label className="rw-still__check">
            <input type="checkbox" data-testid="still.denoise" checked={denoise} disabled={busy} onChange={(e) => setDenoise(e.currentTarget.checked)} />
            Denoise
          </label>
        )}
        <span className="rw-still__meta">
          {width}×{height}
          {section ? " · Section" : ""}
        </span>
        <button type="button" className="rw-still__go" data-testid="still.render" disabled={busy} onClick={start}>
          {busy ? "Rendering…" : done ? "Render again" : "Render"}
        </button>
      </div>
      {phase.kind === "rendering" && (
        <div className="rw-still__progress" data-testid="still.progress">
          <span style={{ width: `${Math.min(100, (100 * phase.done) / Math.max(1, phase.target))}%` }} />
          <em>
            Tracing {phase.done} / {phase.target} spp
          </em>
        </div>
      )}
      {phase.kind === "error" && <p className="rw-still__error">{phase.message}</p>}
      {phase.kind === "done" && (
        <>
          <img className="rw-still__image" data-testid="still.image" src={phase.url} alt="Path-traced still of the current view" />
          <footer className="rw-still__foot">
            <span>
              {phase.out.samples.min} spp · {(phase.out.traceMs / 1000).toFixed(1)} s{phase.out.denoised ? " · denoised" : ""}
            </span>
            <a className="rw-still__save" data-testid="still.save" href={phase.url} download={fileName}>
              Save PNG
            </a>
          </footer>
        </>
      )}
    </div>
  );
}
