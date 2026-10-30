/**
 * Page 03 motor casing view (FID-03-05): the casing (`casing3d.ts`) live on
 * the shared studio stage (`viewport/productStage.ts`): brushed metal PBR,
 * the soft contact shadow it rests on (`CASING_STAGE_LOOK`: a tight dark
 * core and a short penumbra), and the light pool on the vignetted
 * backdrop, as page 01. Renders on demand (motor, style, view, size). Without
 * WebGPU it keeps the shaded SVG (`CasingRender`); `data-source` tells
 * captures which one shows (`render` | `svg`).
 */
import { useEffect, useRef, useState } from "react";
import type { schema } from "@rw/contracts";
import type { DeepReadonly } from "../../state/index.ts";
import type { PoolScreen } from "../../viewport/engine.ts";
import { ProductStage } from "../../viewport/productStage.ts";
import { poolCss } from "../../viewport/stage.ts";
import { buildCasing, CASING_FLOOR_GAP, CASING_STAGE_LOOK, casingPose, type CasingStyle } from "./casing3d.ts";
import { CasingRender } from "./MotorGraphics.tsx";

type Curve = DeepReadonly<schema.ThrustCurve>;

const POOL = poolCss();

type Phase = "pending" | "render" | "svg";

export function CasingView({ curve, width, height, style, view }: { curve: Curve; width: number; height: number; style: CasingStyle; view: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<ProductStage | null>(null);
  const [phase, setPhase] = useState<Phase>("pending");
  const [pool, setPool] = useState<PoolScreen | null>(null);
  const [ready, setReady] = useState(false);

  // One stage per mounted view.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let alive = true;
    void ProductStage.create(canvas, CASING_STAGE_LOOK)
      .then((s) => {
        if (!alive) {
          s?.dispose();
          return;
        }
        stageRef.current = s;
        setPhase(s ? "render" : "svg");
      })
      .catch(() => alive && setPhase("svg"));
    return () => {
      alive = false;
      stageRef.current?.dispose();
      stageRef.current = null;
    };
  }, []);

  useEffect(() => {
    const stage = stageRef.current;
    if (phase !== "render" || !stage) return;
    let alive = true;
    setReady(false);
    const model = buildCasing(curve.length, curve.diameter, style);
    const pose = casingPose(view);
    model.group.rotation.y = -pose.yaw;
    stage.setSize(width, height, window.devicePixelRatio || 1);
    stage.show(model.group, { ...pose.shot, radius: curve.diameter / 2, floorGap: CASING_FLOOR_GAP, shadow: style === "realistic" ? 1 : 0.7 });
    void stage
      .compile()
      .catch(() => undefined)
      .then(() => {
        if (!alive) return;
        stage.render();
        setPool(stage.pool());
        setReady(true);
      });
    return () => {
      alive = false;
      stage.clear();
      model.dispose();
    };
  }, [phase, curve.length, curve.diameter, style, view, width, height]);

  if (phase === "svg") return <CasingRender curve={curve} width={width} height={height} style={style} view={view} />;
  return (
    <div className="rw-casing-view" data-testid="motor.casing" data-source={phase} data-style={style} data-view={view} data-ready={ready ? "true" : "false"} style={{ width, height }} role="img" aria-label={`${curve.designation} casing`}>
      {pool !== null && (
        <div
          className="rw-casing-view__pool"
          aria-hidden
          style={{ left: pool.x - pool.rx, top: pool.y - pool.ry, width: 2 * pool.rx, height: 2 * pool.ry, transform: `rotate(${pool.angleDeg.toFixed(2)}deg)`, background: POOL }}
        />
      )}
      <canvas ref={canvasRef} className="rw-casing-view__canvas" width={width} height={height} />
    </div>
  );
}
