/**
 * Page 05 connectivity diagram (concept 05, lower left): the engine's flow
 * graph as icon nodes and elbow connectors with arrowheads, oxidizer lines
 * teal and fuel lines amber. The selection is the page's one selection: a
 * node or edge clicked here selects the same entity in the 3D view, the rail,
 * and the inspector, and the selected connection's lines and endpoint nodes
 * are drawn selected.
 */
import { Icon } from "../../shell/Icon.tsx";
import type { Connection, DiagramLayout, FeedTarget } from "./model.ts";

export interface DiagramProps {
  layout: DiagramLayout;
  target: FeedTarget | null;
  connection: Connection | null;
  onSelectNode: (id: string) => void;
  onSelectEdge: (index: number) => void;
}

const PAD = { x: 12, y: 14 };

export function ConnectivityDiagram({ layout, target, connection, onSelectNode, onSelectEdge }: DiagramProps) {
  const onEdges = new Set(connection?.edges ?? []);
  const endpoints = new Set([...(connection?.from ?? []), ...(connection?.to ?? [])]);
  const selectedNode = target?.kind === "node" ? target.id : null;
  const w = layout.width + PAD.x * 2;
  const h = layout.height + PAD.y * 2;
  return (
    <section className="rw-liq-diagram" data-rw-region="connectivity-diagram" data-testid="connectivity-diagram" aria-label="Connectivity diagram">
      <header className="rw-liq-panel__head">
        <h2 className="rw-liq-panel__title">Connectivity diagram</h2>
        <span className="rw-liq-legend" aria-hidden>
          <span className="rw-liq-legend__swatch" data-role="ox" /> Oxidizer
          <span className="rw-liq-legend__swatch" data-role="fuel" /> Fuel
        </span>
      </header>
      <div className="rw-liq-diagram__canvas" style={{ width: w, height: h }}>
        <svg className="rw-liq-diagram__edges" width={w} height={h} aria-hidden>
          <defs>
            {(["ox", "fuel", "none"] as const).map((r) => (
              <marker key={r} id={`rw-liq-arrow-${r}`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0 0 L8 4 L0 8 z" className="rw-liq-arrow" data-role={r} />
              </marker>
            ))}
          </defs>
          {layout.edges.map((e) => {
            const pts = e.points.map(([x, y]) => `${x + PAD.x},${y + PAD.y}`).join(" ");
            const role = e.role ?? "none";
            return (
              <g key={e.index}>
                <polyline
                  className="rw-liq-edge"
                  data-testid="diagram.edge"
                  data-edge={e.index}
                  data-role={role}
                  data-selected={onEdges.has(e.index) ? "true" : "false"}
                  points={pts}
                  markerEnd={`url(#rw-liq-arrow-${role})`}
                />
                {/* A wide transparent hit line over the thin stroke. */}
                <polyline className="rw-liq-edge__hit" data-testid="diagram.edge-hit" data-edge={e.index} points={pts} onClick={() => onSelectEdge(e.index)} role="button" aria-label={`Select the line ${e.from} to ${e.to}`} />
              </g>
            );
          })}
        </svg>
        {layout.nodes.map((n) => (
          <button
            key={n.id}
            type="button"
            className="rw-liq-node"
            data-testid="diagram.node"
            data-node={n.id}
            data-role={n.role ?? undefined}
            data-selected={selectedNode === n.id || (selectedNode === null && endpoints.has(n.id) && n.role !== null) ? "true" : "false"}
            aria-pressed={selectedNode === n.id}
            style={{ left: n.x + PAD.x, top: n.y + PAD.y, width: n.w, height: n.h }}
            onClick={() => onSelectNode(n.id)}
          >
            <span className="rw-liq-node__icon">
              <Icon name={n.icon} size={24} />
            </span>
            <span className="rw-liq-node__label">{n.label}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
