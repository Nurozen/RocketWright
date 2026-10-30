/**
 * RL5 spike: the complete recovery-bay scene of concept 01, rendered by the
 * production viewport engine (`ViewportEngine`, WebGPU, outline pipeline)
 * from the research-vehicle fixture through rw-wasm, with the detail
 * pipeline (`src/detail/registry.ts`) applied: folded chute in the clear
 * bay, rods and machined caps, electronics bay with board and battery,
 * bevelled tubes and rings, motor fittings, exploded spacing, the page-01
 * framing preset, and leader labels.
 *
 * Open with `index.html?mode=spike&spike=recovery-bay&frame=01|01-focus`.
 * Publishes `window.__rwProbe` (ready + metrics) for the desktop capture
 * (`capture.ts`).
 */
import "../../src/pages/assembly/assembly.css";
import { useEffect, useRef, useState } from "react";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import * as THREE from "three/webgpu";
import { loadRwWasm } from "@rw/rw-wasm";
import { applyDetail, defaultDetailRegistry, explodeLayout, fitCamera, FRAMING_PRESETS, presetPose, type FramingId, type Vec3 } from "../../src/detail/registry.ts";
import { ViewportEngine } from "../../src/viewport/engine.ts";
import { glbModelHash } from "../../src/viewport/glb-source.ts";
import { labelsDisjoint, layoutLabels, type PlacedLabel } from "../../src/viewport/labels.ts";
import { settle } from "../../src/viewport/registry.ts";
import { AssemblyModel, type PartMeta } from "../../src/viewport/scene.ts";
import { RESEARCH_VEHICLE } from "./fixture.ts";

/** Clear gap between exploded items, in body diameters. */
const GAP_DIAMETERS = 0.75;

export function isFramingId(s: string | null): s is FramingId {
  return s !== null && s in FRAMING_PRESETS;
}

/** World (three.js Y-up) -> body frame: (x, y, z) -> (x, -z, y). */
const worldToBody = (v: Vec3): Vec3 => [v[0], -v[2], v[1]];

interface Overlay {
  labels: PlacedLabel[];
  selected: string | null;
}

export interface SpikeDebug {
  /** Skip the selection outline (A/B the outline's tint). */
  noSelect?: boolean;
  /** Hide one detail mesh by name (A/B a layer). */
  hideMesh?: string;
}

export function RecoveryBaySpike({ frame, debug = {} }: { frame: FramingId; debug?: SpikeDebug }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [overlay, setOverlay] = useState<Overlay>({ labels: [], selected: null });
  const [size, setSize] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const preset = FRAMING_PRESETS[frame];
    const engine = new ViewportEngine(canvas);
    let disposeDetail: (() => void) | null = null;
    let alive = true;
    window.__rwProbe = { status: "pending" };
    const t0 = performance.now();
    void (async () => {
      const r = wrap.getBoundingClientRect();
      const w = Math.round(r.width);
      const h = Math.round(r.height);
      setSize({ w, h });
      engine.resize(w, h, 0);
      const backend = await engine.init();
      const rw = await loadRwWasm();
      const ev = rw.evalModel(RESEARCH_VEHICLE);
      const glb = rw.meshModelGlb(ev, { radial_segments: 96 });
      const ab = glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength) as ArrayBuffer;
      const gltf = await new GLTFLoader().parseAsync(ab, "");
      if (!alive) return;
      const meta: Record<string, PartMeta> = {};
      for (const c of ev.components) meta[c.id] = { name: c.name, appearance: c.appearance ?? null };
      const model = new AssemblyModel(gltf.scene, meta, glbModelHash(glb));
      const tDetail = performance.now();
      const applied = applyDetail(model, ev.components, defaultDetailRegistry(), { segments: 96 });
      const detailMs = performance.now() - tDetail;
      disposeDetail = applied.dispose;

      // Exploded spacing from the measured (detailed) extents at explode 0.
      const box = new THREE.Box3();
      const maxOd = Math.max(...ev.components.map((c) => (c.containment === "axial" ? 2 * (c.anchors.find((a) => a.name === "outer")?.r ?? 0) : 0)), 0.01);
      const layout = explodeLayout({
        components: ev.components,
        isClear: (id) => model.parts.get(id)?.look.clear ?? false,
        gap: GAP_DIAMETERS * maxOd,
        extent: (id) => {
          const b = model.partBounds(id, box);
          return b && !b.isEmpty() ? [b.min.x, b.max.x] : null;
        },
      });
      for (const p of model.parts.values()) p.explode.set(layout.offset.get(p.id) ?? 0, 0, 0);

      const select = preset.select !== null && model.parts.has(preset.select) ? preset.select : null;
      const subject = new Set<string>();
      if (preset.subject === "selection" && select !== null) {
        subject.add(select);
        for (const [rider, carrier] of layout.carrier) if (carrier === select) subject.add(rider);
      } else for (const id of model.parts.keys()) subject.add(id);
      const hidden = [...model.parts.keys()].filter((id) => !subject.has(id));
      engine.setModel(model);
      engine.setState({ view: "iso", explode: preset.explode, section: false, showInternals: false, shadows: preset.shadows, hidden, selected: select && !debug.noSelect ? [select] : [] });
      if (debug.hideMesh) model.root.traverse((o) => { if (o.name === debug.hideMesh) o.visible = false; });

      // Page framing: fit the visible parts' box corners into the preset rectangle.
      const pts: Vec3[] = [];
      for (const id of subject) {
        const b = model.partBounds(id, box);
        if (!b || b.isEmpty()) continue;
        for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) pts.push([x, y, z]);
      }
      const pose = presetPose(preset);
      const fit = fitCamera(pts, pose, preset.fovDeg, w / h, preset.fit);
      engine.camera.fov = preset.fovDeg;
      engine.camera.up.set(...fit.up);
      engine.setCamera(worldToBody(fit.position), worldToBody(fit.target));
      await settle();

      // Leader labels for the spaced items (riders ride inside their carriers' labels).
      const names = new Map(ev.components.map((c) => [c.id, c.name]));
      const items = new Set(layout.order);
      const anchors = preset.labels === "items" ? engine.screenParts().filter((p) => items.has(p.id) && subject.has(p.id)).map((p) => ({ id: p.id, text: names.get(p.id) ?? p.id, x: p.x, y: p.y, r: p.r, order: p.order })) : [];
      const axis = engine.axisOnScreen();
      let normal: [number, number] = [axis[1], -axis[0]];
      if (normal[0] < 0 || (normal[0] === 0 && normal[1] > 0)) normal = [-normal[0], -normal[1]];
      const labels = layoutLabels(anchors, { width: w, height: h, normal, obstacles: engine.partFootprints() });
      setOverlay({ labels, selected: select });
      await settle();
      await settle();
      if (!alive) return;

      const rect = (id: string) => {
        const b = model.partBounds(id, box);
        if (!b || b.isEmpty()) return null;
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) {
          const s = engine.project(new THREE.Vector3(x, y, z));
          x0 = Math.min(x0, s.x);
          y0 = Math.min(y0, s.y);
          x1 = Math.max(x1, s.x);
          y1 = Math.max(y1, s.y);
        }
        return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      };
      window.__rwProbe = {
        status: "ready",
        probe: {
          spike: "recovery-bay",
          frame,
          backend,
          adapter: engine.adapterLabel(),
          error: engine.error,
          size: { w, h },
          detail: applied.report,
          detailMs: Math.round(detailMs),
          totalMs: Math.round(performance.now() - t0),
          order: layout.order,
          offsets: Object.fromEntries([...layout.offset].map(([k, v]) => [k, Number(v.toFixed(4))])),
          visible: [...subject],
          outlined: engine.outlinedParts(),
          bayRect: rect("recovery_bay"),
          ebayRect: rect("ebay"),
          fitBounds: fit.bounds,
          labels: labels.map((l) => ({ id: l.id, box: l.box, collided: l.collided })),
          labelsDisjoint: labelsDisjoint(labels, 2),
        },
      } as unknown as NonNullable<Window["__rwProbe"]>;
    })().catch((e: unknown) => {
      window.__rwProbe = { status: "error", error: e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e) };
    });
    return () => {
      alive = false;
      engine.dispose();
      disposeDetail?.();
    };
  }, [frame, debug.noSelect, debug.hideMesh]);

  return (
    <div ref={wrapRef} className="rw-viewport rw-asm-viewport" data-testid="spike.recovery-bay" data-frame={frame} style={{ position: "fixed", inset: 0 }}>
      <canvas ref={canvasRef} className="rw-asm-viewport__canvas" />
      <svg className="rw-asm-leaders" width={size.w} height={size.h} aria-hidden>
        {overlay.labels.map((l) => (
          <polyline
            key={l.id}
            className="rw-asm-leader"
            data-selected={l.id === overlay.selected ? "true" : undefined}
            points={`${l.start[0]},${l.start[1]} ${l.elbow[0]},${l.elbow[1]} ${l.end[0]},${l.end[1]}`}
          />
        ))}
        {overlay.labels.map((l) => (
          <circle key={`${l.id}-dot`} className="rw-asm-leader__dot" cx={l.start[0]} cy={l.start[1]} r={1.6} />
        ))}
      </svg>
      {overlay.labels.map((l) => (
        <span
          key={l.id}
          className="rw-asm-label"
          data-part={l.id}
          data-selected={l.id === overlay.selected ? "true" : "false"}
          style={{ left: l.box.x, top: l.box.y, width: l.box.w, height: l.box.h, textAlign: l.side > 0 ? "left" : "right" }}
        >
          {l.text}
        </span>
      ))}
    </div>
  );
}
