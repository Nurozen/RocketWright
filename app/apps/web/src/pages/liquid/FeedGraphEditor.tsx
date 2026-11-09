/**
 * The feed graph card of the liquid engine editor (R3.2): one row per node and
 * one per connection, each a named group so the same labels can repeat, and
 * every input the file can hold editable. Connections are the graph's edges;
 * "line" is already a node kind.
 */
import { useMemo, useState } from "react";
import type { PatchOp, schema } from "@rw/contracts";
import { Icon } from "../../shell/Icon.tsx";
import { trackWrite } from "../../state/dirtyFields.ts";
import { useAppState, type AppStore, type DeepReadonly } from "../../state/index.ts";
import { Modal } from "../../ui/Modal.tsx";
import { FieldGroupFrame, SelectField, TextField } from "../../ui/fields/index.ts";
import { DiagnosticText } from "../../ui/DiagnosticText.tsx";
import { FieldRow, message, useTextEdit, type RowContext } from "./EngineFields.tsx";
import {
  NODE_KINDS,
  NODE_KIND_LABELS,
  addEdgeOps,
  addFillOps,
  addInlineTankOps,
  addNodeOps,
  addWaypointOps,
  edgeFields,
  feedChoices,
  kindField,
  nodeFields,
  nodeIdProblem,
  nodeRemovalScope,
  removeEdgeOps,
  removeNodeOps,
  removeWaypointOps,
  renameNodeOps,
  tankGeometryState,
  waypointFields,
  type FeedChoices,
} from "./feedOps.ts";
import { feedTarget, nodeLabel } from "./model.ts";

type Model = DeepReadonly<schema.EvaluatedModel>;

interface FeedProps {
  ctx: RowContext;
  model: Model | null;
  /** A write that changes the graph's shape: selected feed entities may no longer exist after it. */
  change: (ops: PatchOp[], label: string) => void;
  onProblem: (text: string) => void;
}

function NodeIdRow({ id, ctx, model }: { id: string; ctx: RowContext; model: Model | null }) {
  const edit = useTextEdit(
    id,
    (text) => nodeIdProblem(text, id, ctx.engine),
    (text) => ctx.write(renameNodeOps(ctx.engineId, id, text.trim(), ctx.engine, model), `Rename ${nodeLabel(id)}`),
  );
  return (
    <div className="rw-liq-editor__row">
      <TextField
        testid="liquid-editor.field"
        field={{ key: `feed.node.${id}`, label: "Node id" }}
        value={edit.value}
        placeholder=""
        title="Connections and visual studies refer to the node by this id; renaming updates them."
        byAgent={false}
        error={edit.error}
        onChange={edit.onChange}
        onCommit={edit.onCommit}
        onDiscard={edit.onDiscard}
      />
      {edit.error !== null && (
        <p className="rw-liq-editor__error" role="alert" data-field={`feed.node.${id}`}>
          {edit.error}
        </p>
      )}
    </div>
  );
}

function NodeRow({ id, choices, feed, onRemove }: { id: string; choices: FeedChoices; feed: FeedProps; onRemove: (id: string) => void }) {
  const { ctx, model, change, onProblem } = feed;
  const node = ctx.engine.nodes[id];
  const geometry = tankGeometryState(id, ctx.source);
  const isTank = node?.kind === "tank";
  return (
    <FieldGroupFrame heading={nodeLabel(id)} group={`node:${id}`}>
      <div className="rw-liq-feed__row" data-testid="liquid.feed-node" data-node={id}>
        <NodeIdRow id={id} ctx={ctx} model={model} />
        <FieldRow field={kindField(id)} ctx={ctx} onProblem={onProblem} />
        {nodeFields(ctx.engine, id, ctx.source, choices).map((f) => (
          <FieldRow key={f.key} field={f} ctx={ctx} onProblem={onProblem} />
        ))}
      </div>
      <div className="rw-liq-feed__actions">
        {isTank && !geometry.inline && !geometry.component && (
          <button type="button" className="rw-button" data-testid="liquid.feed-add-geometry" onClick={() => change(addInlineTankOps(ctx.engineId, id), `Add tank geometry to ${nodeLabel(id)}`)}>
            Add tank geometry
          </button>
        )}
        {isTank && geometry.inline && !geometry.fill && (
          <button type="button" className="rw-button" data-testid="liquid.feed-add-fill" onClick={() => change(addFillOps(ctx.engineId, id, ctx.engine), `Add fill to ${nodeLabel(id)}`)}>
            Add fill
          </button>
        )}
        <button type="button" className="rw-button" aria-label={`Remove node ${nodeLabel(id)}`} data-testid="liquid.feed-remove-node" onClick={() => onRemove(id)}>
          <Icon name="trash" size={18} />
          Remove
        </button>
      </div>
    </FieldGroupFrame>
  );
}

function WaypointRow({ edge, point, feed }: { edge: number; point: number; feed: FeedProps }) {
  const { ctx, change, onProblem } = feed;
  const heading = `Waypoint ${point + 1}`;
  return (
    <FieldGroupFrame heading={heading} group={`waypoint:${edge}:${point}`}>
      <div className="rw-liq-feed__row" data-testid="liquid.feed-waypoint">
        {waypointFields(ctx.engine, edge, point).map((f) => (
          <FieldRow key={f.key} field={f} ctx={ctx} onProblem={onProblem} />
        ))}
      </div>
      <div className="rw-liq-feed__actions">
        <button type="button" className="rw-button" aria-label={`Remove ${heading} of connection ${edge + 1}`} data-testid="liquid.feed-remove-waypoint" onClick={() => change(removeWaypointOps(ctx.engineId, ctx.engine, edge, point), `Remove ${heading}`)}>
          <Icon name="trash" size={18} />
          Remove
        </button>
      </div>
    </FieldGroupFrame>
  );
}

function EdgeRow({ index, feed }: { index: number; feed: FeedProps }) {
  const { ctx, change, onProblem } = feed;
  const edge = ctx.engine.edges[index];
  if (edge === undefined) return null;
  const heading = `Connection ${index + 1}: ${nodeLabel(edge.from)} to ${nodeLabel(edge.to)}`;
  const points = edge.waypoints?.length ?? 0;
  return (
    <FieldGroupFrame heading={heading} group={`edge:${index}`}>
      <div className="rw-liq-feed__row" data-testid="liquid.feed-edge" data-edge={index}>
        {edgeFields(ctx.engine, index).map((f) => (
          <FieldRow key={f.key} field={f} ctx={ctx} onProblem={onProblem} />
        ))}
      </div>
      {points > 0 && (
        <div className="rw-liq-feed__waypoints">
          {Array.from({ length: points }, (_, k) => (
            <WaypointRow key={k} edge={index} point={k} feed={feed} />
          ))}
        </div>
      )}
      <div className="rw-liq-feed__actions">
        <button type="button" className="rw-button" aria-label={`Add waypoint to connection ${index + 1}`} data-testid="liquid.feed-add-waypoint" onClick={() => change(addWaypointOps(ctx.engineId, ctx.engine, index), `Add waypoint to connection ${index + 1}`)}>
          <Icon name="plus" size={18} />
          Add waypoint
        </button>
        <button type="button" className="rw-button" aria-label={`Remove connection ${index + 1}`} data-testid="liquid.feed-remove-edge" onClick={() => change(removeEdgeOps(ctx.engineId, index), `Remove connection ${index + 1}`)}>
          <Icon name="trash" size={18} />
          Remove
        </button>
      </div>
    </FieldGroupFrame>
  );
}

function RemoveNodeDialog({ id, feed, onClose }: { id: string; feed: FeedProps; onClose: () => void }) {
  const { ctx, model, change } = feed;
  const scope = nodeRemovalScope(id, ctx.engine, ctx.engineId, model);
  const also = [scope.edges.length > 0 ? `${scope.edges.length} connection${scope.edges.length === 1 ? "" : "s"}` : null, scope.studies > 0 ? `the tank choice of ${scope.studies} visual stud${scope.studies === 1 ? "y" : "ies"}` : null].filter((x) => x !== null);
  const remove = () => {
    change(removeNodeOps(ctx.engineId, id, ctx.engine, model), `Remove ${nodeLabel(id)}`);
    onClose();
  };
  return (
    <Modal
      open
      onClose={onClose}
      title="Remove node"
      testId="remove-feed-node"
      footer={
        <>
          <button type="button" className="rw-button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="rw-button rw-button--danger" onClick={remove}>
            Remove
          </button>
        </>
      }
    >
      <p>{`Remove ${nodeLabel(id)}?${also.length > 0 ? ` This also removes ${also.join(" and ")} that use it.` : ""}`}</p>
    </Modal>
  );
}

/** What the check says about the graph as a whole or a whole node, which no single field can carry. */
function GraphDiagnostics({ engineId, nodes }: { engineId: string; nodes: readonly { path?: string | null; code: string; severity: string; message: string }[] }) {
  if (nodes.length === 0) return null;
  return (
    <ul className="rw-liq-feed__diagnostics" data-testid="liquid.feed-diagnostics" data-engine={engineId}>
      {nodes.map((d, i) => (
        <li key={`${d.code}:${i}`} data-code={d.code} data-severity={d.severity}>
          <DiagnosticText text={d.message} />
        </li>
      ))}
    </ul>
  );
}

export function FeedGraphEditor({ app, ctx, onProblem }: { app: AppStore; ctx: RowContext; onProblem: (text: string) => void }) {
  const model = useAppState(app, (s) => s.project.snapshot?.evaluated ?? null) as Model | null;
  const diagnostics = useAppState(app, (s) => s.project.snapshot?.check?.diagnostics ?? null);
  const choices = useMemo(() => feedChoices(model), [model]);
  const [newKind, setNewKind] = useState<schema.FeedNodeKind>("tank");
  const [removing, setRemoving] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const change = (ops: PatchOp[], label: string) => {
    trackWrite(ctx.write(ops, label))
      .then(() => {
        // A selected node or connection may be gone or renumbered now.
        const selection = app.getState().selection;
        if (selection.refs.some((r) => feedTarget(r)?.engine === ctx.engineId)) selection.select([], "inspector");
      })
      .catch((e: unknown) => onProblem(message(e)));
  };
  const feed: FeedProps = { ctx, model, change, onProblem };
  const ids = Object.keys(ctx.engine.nodes).sort();
  const edgeOps = addEdgeOps(ctx.engineId, ctx.engine);
  const base = `/engines/${ctx.engineId}/feed`;
  const general = (diagnostics ?? []).filter((d) => {
    const path = d.path ?? "";
    if (d.severity !== "error" || !path.startsWith(base)) return false;
    // A diagnostic on a single input shows at that input; the rest are about a node or the graph.
    return path === base || path === `${base}/node` || /\/node\/[^/]+(\/tank)?$/.test(path);
  });

  const addNode = () => {
    setAdding(true);
    const { id, ops } = addNodeOps(ctx.engineId, newKind, ctx.engine, ctx.source);
    trackWrite(ctx.write(ops, `Add ${NODE_KIND_LABELS[newKind]} node ${id}`))
      .catch((e: unknown) => onProblem(message(e)))
      .finally(() => setAdding(false));
  };

  return (
    <FieldGroupFrame heading="Feed graph" group="Feed graph">
      <GraphDiagnostics engineId={ctx.engineId} nodes={general} />
      <section className="rw-liq-feed__section" aria-label="Nodes">
        <div className="rw-liq-feed__head">
          <h4 className="rw-liq-feed__title">Nodes</h4>
          <div className="rw-liq-feed__add">
            <SelectField testid="liquid.feed-new-kind" field={{ key: "new-node-kind", label: "New node kind" }} value={newKind} options={NODE_KINDS} labels={NODE_KIND_LABELS} placeholder={null} title={undefined} byAgent={false} onChange={(v) => setNewKind(v as schema.FeedNodeKind)} />
            <button type="button" className="rw-button" data-testid="liquid.feed-add-node" disabled={adding} aria-busy={adding} onClick={addNode}>
              <Icon name="plus" size={18} />
              Add node
            </button>
          </div>
        </div>
        {ids.length === 0 ? <p className="rw-liq-editor__empty">No feed nodes yet. Add the tanks, valves and the engine node here.</p> : ids.map((id) => <NodeRow key={id} id={id} choices={choices} feed={feed} onRemove={setRemoving} />)}
      </section>
      <section className="rw-liq-feed__section" aria-label="Connections">
        <div className="rw-liq-feed__head">
          <h4 className="rw-liq-feed__title">Connections</h4>
          <button type="button" className="rw-button" data-testid="liquid.feed-add-edge" disabled={edgeOps === null} title={edgeOps === null ? "A connection joins two nodes: add them first." : undefined} onClick={() => edgeOps !== null && change(edgeOps, "Add connection")}>
            <Icon name="plus" size={18} />
            Add connection
          </button>
        </div>
        {ctx.engine.edges.length === 0 ? <p className="rw-liq-editor__empty">No connections yet.</p> : ctx.engine.edges.map((_, i) => <EdgeRow key={i} index={i} feed={feed} />)}
      </section>
      {removing !== null && ctx.engine.nodes[removing] !== undefined && <RemoveNodeDialog id={removing} feed={feed} onClose={() => setRemoving(null)} />}
    </FieldGroupFrame>
  );
}
