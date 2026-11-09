/**
 * The 2D drawing: the same `render` output the agent gets (R3.8), for the
 * four views the Rust drawing code makes. Opening it draws the first view and
 * every view change draws again, so what shows always matches the live model.
 */
import { useEffect, useState } from "react";
import type { schema } from "@rw/contracts";
import type { RpcLike } from "../../state/rpc.ts";
import { Modal } from "../../ui/Modal.tsx";
import { RadioCardGroup, type RadioCardOption } from "../../ui/RadioCard.tsx";

type DrawingView = Extract<schema.View, "profile" | "fin" | "stations" | "anchors">;

const VIEWS: readonly RadioCardOption<DrawingView>[] = [
  { value: "profile", title: "Profile", description: "Side view with internals and overall dimensions" },
  { value: "fin", title: "Fin", description: "Each fin set with chord, span and sweep" },
  { value: "stations", title: "Stations", description: "Every component station marked" },
  { value: "anchors", title: "Anchors", description: "Every named anchor marked" },
];

/** `<base>/api/projects/<p>/renders/<file>.png?v=<sha>`: the file keeps its name across redraws, so the hash busts the image cache. */
export function drawingUrl(httpBase: string, projectId: string, render: Pick<schema.RenderResult, "path" | "png_sha256">): string {
  const file = render.path.slice(render.path.lastIndexOf("/") + 1);
  return `${httpBase}/api/projects/${encodeURIComponent(projectId)}/renders/${encodeURIComponent(file)}?v=${render.png_sha256}`;
}

type Drawn = { status: "drawing" } | { status: "ready"; render: schema.RenderResult } | { status: "error"; message: string };

export interface DrawingDialogProps {
  client: RpcLike;
  projectId: string;
  httpBase: string;
  onClose: () => void;
}

export function DrawingDialog({ client, projectId, httpBase, onClose }: DrawingDialogProps) {
  const [view, setView] = useState<DrawingView>("profile");
  const [attempt, setAttempt] = useState(0);
  const [drawn, setDrawn] = useState<Drawn>({ status: "drawing" });
  const [brokenUrl, setBrokenUrl] = useState<string | null>(null);

  useEffect(() => {
    // A slower answer for the previous view must not replace the current one.
    let current = true;
    setDrawn({ status: "drawing" });
    client.call("render", { projectId, view }).then(
      (render) => {
        if (current) setDrawn({ status: "ready", render });
      },
      (e: unknown) => {
        if (current) setDrawn({ status: "error", message: e instanceof Error ? e.message : String(e) });
      },
    );
    return () => {
      current = false;
    };
  }, [client, projectId, view, attempt]);

  const retry = () => {
    setBrokenUrl(null);
    setAttempt((n) => n + 1);
  };
  const title = VIEWS.find((v) => v.value === view)?.title ?? view;
  const url = drawn.status === "ready" ? drawingUrl(httpBase, projectId, drawn.render) : null;
  const problem = drawn.status === "error" ? `The drawing failed: ${drawn.message}` : url !== null && url === brokenUrl ? "The drawing was made but could not be loaded." : null;

  return (
    <Modal
      open
      onClose={onClose}
      title="2D drawing"
      testId="drawing.dialog"
      footer={
        <button type="button" className="rw-button" onClick={onClose}>
          Close
        </button>
      }
    >
      <RadioCardGroup label="View" value={view} options={VIEWS} onChange={setView} />
      <div className="rw-drawing__stage">
        {problem !== null ? (
          <div className="rw-drawing__problem" role="alert">
            <span>{problem}</span>
            <button type="button" className="rw-button rw-button--quiet" onClick={retry}>
              Try again
            </button>
          </div>
        ) : drawn.status === "ready" && url !== null ? (
          <img className="rw-drawing__picture" src={url} width={drawn.render.width} height={drawn.render.height} alt={`${title} drawing of the rocket`} onError={() => setBrokenUrl(url)} />
        ) : (
          <span role="status">Drawing…</span>
        )}
      </div>
      {drawn.status === "ready" && problem === null && <p className="rw-drawing__file">Saved in the project as {drawn.render.path}</p>}
    </Modal>
  );
}
