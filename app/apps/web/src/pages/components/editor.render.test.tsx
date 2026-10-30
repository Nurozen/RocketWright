/**
 * M2.9 editor markup: the fin set's schema fields in two columns with units,
 * the agent-change marker, the Modified status, Parts library and Revert, the fin
 * profile, and the agent pane cards (static render, no GPU).
 */
import { readFileSync } from "node:fs";
import type { EvaluatedModel } from "@rw/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChangedFieldsCard, ThreadHistory } from "./AgentExtras.tsx";
import { ComponentEditor, type ComponentEditorProps } from "./ComponentEditor.tsx";

const repo = new URL("../../../../../../", import.meta.url);
const evaluated = (JSON.parse(readFileSync(new URL("fixtures/contracts/evaluated-model.json", repo), "utf8")) as { payload: EvaluatedModel }).payload;
const fins = evaluated.components.find((c) => c.id === "fins")!;
const nose = evaluated.components.find((c) => c.id === "nose")!;

const FILES = { "rocket.rw.toml": '[params.fin_span]\nvalue = "90 mm"\nmin = "60 mm"\nmax = "120 mm"\n[c.fins]\nspan = "= params.fin_span"\n' };

function props(over: Partial<ComponentEditorProps> = {}): ComponentEditorProps {
  const noop = () => undefined;
  return {
    comps: [fins],
    files: FILES,
    units: "mm",
    materials: ["balsa", "plywood"],
    diagnostics: [],
    status: { kind: "modified", detail: "Simulation needs rerun" },
    tab: "Geometry",
    onTab: noop,
    collapsed: false,
    onCollapse: noop,
    canRevert: true,
    onEdit: noop,
    onCommit: noop,
    onDiscard: noop,
    onRevert: noop,
    library: { state: "idle", items: [] },
    onOpenLibrary: noop,
    onApplyPreset: noop,
    ...over,
  };
}

describe("component editor markup", () => {
  it("renders the fin set's fields, link, status, actions, and profile", () => {
    const html = renderToStaticMarkup(<ComponentEditor {...props()} />);
    for (const label of ["Root chord", "Tip chord", "Span", "Sweep", "Thickness", "Fin count"]) expect(html).toContain(label);
    expect(html).toContain('data-field="span"');
    expect(html).toContain('value="90"');
    // The shared parameter is explained in words in the tooltip; the source path never shows.
    expect(html).not.toContain("params.");
    expect(html).toContain("Shared value “fin span”");
    expect(html).not.toContain("Changed by agent");
    expect(html).toContain("Modified");
    expect(html).toContain("Simulation needs rerun");
    expect(html).toContain("Parts library");
    expect(html).toContain("Revert change");
    expect(html).toContain("Fin profile (side view)");
    expect(html).toContain('data-rw-region="editor"');
  });

  it("marks the fields the agent changed with words, not ids", () => {
    const html = renderToStaticMarkup(<ComponentEditor {...props({ agentChanged: ["span", "sweep"] })} />);
    expect(html.match(/data-testid="editor.field-changed"/g)).toHaveLength(2);
    expect(html).toMatch(/data-field="span"[^>]*data-by-agent="true"/);
    expect(html).toContain("Changed by agent");
    expect(html).not.toContain("params.");
  });

  it("shows only Appearance for a mixed selection, and collapses", () => {
    const mixed = renderToStaticMarkup(<ComponentEditor {...props({ comps: [fins, nose] })} />);
    expect(mixed.match(/data-testid="editor.tab"/g)).toHaveLength(1);
    expect(mixed).toContain("2 parts");
    const collapsed = renderToStaticMarkup(<ComponentEditor {...props({ collapsed: true })} />);
    expect(collapsed).not.toContain("editor.tab");
    expect(collapsed).toContain('aria-expanded="false"');
  });

  it("renders the Changed fields card and this thread's history", () => {
    const card = renderToStaticMarkup(<ChangedFieldsCard fields={[{ key: "span", label: "Span", dim: "length", old: 0.12, new: 0.09 }]} units="mm" source="Step 02 → 03" onCompare={() => undefined} />);
    expect(card).toContain("120 → 90 mm");
    expect(card).toContain("Compare revisions");
    const hist = renderToStaticMarkup(
      <ThreadHistory
        items={[
          { seq: 2, title: "Baseline", ts: "2026-10-13T10:15:00Z", baseline: true, current: false, state: "done" },
          { seq: 3, title: "Fin revision", ts: "2026-10-14T11:05:00Z", baseline: false, current: true, state: "current" },
        ]}
        onOpen={() => undefined}
      />,
    );
    expect(hist).toContain("Design history (this thread)");
    expect(hist).toContain('data-current="true"');
    expect(hist).toContain('data-state="done"');
    expect(hist).toContain("Step 03 · ");
  });
});
