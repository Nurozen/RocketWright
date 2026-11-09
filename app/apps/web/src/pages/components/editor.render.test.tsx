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
    materials: { balsa: { density: 120 }, plywood: { density: 630 } },
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

  it("offers a project with no parts the Materials tab, and otherwise the first-part hint", () => {
    const empty = renderToStaticMarkup(<ComponentEditor {...props({ comps: [], noParts: true })} />);
    expect(empty).toContain(">Materials</button>");
    expect(empty).toContain("Add your first part");
    const open = renderToStaticMarkup(<ComponentEditor {...props({ comps: [], noParts: true, tab: "Materials", materialsPanel: <div>the panel</div> })} />);
    expect(open).toContain("the panel");
    expect(open).not.toContain("Add your first part");
  });

  it("offers no Materials tab while nothing can be edited", () => {
    expect(renderToStaticMarkup(<ComponentEditor {...props({ comps: [] })} />)).not.toContain(">Materials</button>");
  });

  it("puts Materials after the part's own tabs, and shows only the panel there", () => {
    const html = renderToStaticMarkup(<ComponentEditor {...props({ tab: "Materials", materialsPanel: <div>the panel</div> })} />);
    expect(html.indexOf(">Mass override</button>")).toBeLessThan(html.indexOf(">Materials</button>"));
    expect(html).toContain("the panel");
    expect(html).not.toContain('data-field="span"');
  });

  it("lists only the materials the part's density kind can use", () => {
    const parachute = evaluated.components.find((c) => c.shape.type === "parachute");
    const materials = { balsa: { density: 120 }, ripstop_nylon: { surface_density: 0.067 } };
    expect(renderToStaticMarkup(<ComponentEditor {...props({ tab: "Material", materials })} />)).toContain("balsa");
    expect(renderToStaticMarkup(<ComponentEditor {...props({ tab: "Material", materials })} />)).not.toContain("ripstop nylon");
    if (parachute !== undefined) {
      const html = renderToStaticMarkup(<ComponentEditor {...props({ comps: [parachute], tab: "Material", materials })} />);
      expect(html).toContain("ripstop nylon");
      expect(html).not.toContain(">balsa<");
    }
  });

  it("links the unit shown beside a number to its input, and leaves a unitless field undescribed", () => {
    const html = renderToStaticMarkup(<ComponentEditor {...props()} />);
    const field = (key: string) => new RegExp(`data-field="${key}"[\\s\\S]*?</label>`).exec(html)?.[0] ?? "";
    const span = field("span");
    const id = /aria-describedby="([^"]+)"/.exec(span)?.[1] ?? "";
    expect(id).not.toBe("");
    expect(span).toContain(`<span id="${id}" class="rw-field__unit">mm</span>`);
    expect(field("count")).toContain("rw-spinbox__input");
    expect(field("count")).not.toContain("aria-describedby");
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

describe("nested groups", () => {
  const shoulder = { length: 0.02, od: 0.023, thickness: 0.002, capped: true };
  const withShoulder = { ...nose, shape: { ...(nose.shape as object), shoulder } } as unknown as typeof nose;
  const noShoulder = { ...nose, shape: { ...(nose.shape as object), shoulder: undefined } } as unknown as typeof nose;

  it("offers a shoulder the part does not have as an Add button, with no leaf fields", () => {
    const html = renderToStaticMarkup(<ComponentEditor {...props({ comps: [noShoulder], files: { "rocket.rw.toml": "[c.nose]\n" } })} />);
    expect(html).toMatch(/<button[^>]*data-testid="editor.add-group"[^>]*>.*Add shoulder<\/button>/s);
    expect(html).not.toContain('data-field="shoulder.length"');
    expect(html).not.toContain('role="group" aria-labelledby');
  });

  it("names the group by its visible heading and links each unit to its input", () => {
    const html = renderToStaticMarkup(<ComponentEditor {...props({ comps: [withShoulder], files: { "rocket.rw.toml": '[c.nose]\nshoulder = { length = "20 mm", od = "23 mm" }\n' } })} />);
    const group = /<div class="rw-field-group" role="group" aria-labelledby="([^"]+)" data-group="shoulder">([\s\S]*?)<\/div><\/div>/.exec(html);
    expect(group).not.toBeNull();
    expect(group?.[2]).toContain(`<h3 id="${group?.[1]}" class="rw-field-group__title">Shoulder</h3>`);
    expect(html).not.toContain("Add shoulder");
    const field = (key: string) => new RegExp(`data-field="${key}"[\\s\\S]*?</label>`).exec(html)?.[0] ?? "";
    const length = field("shoulder.length");
    expect(length).toContain('aria-label="Length"');
    const id = /aria-describedby="([^"]+)"/.exec(length)?.[1] ?? "";
    expect(id).not.toBe("");
    expect(length).toContain(`<span id="${id}" class="rw-field__unit">mm</span>`);
    expect(length).toContain('value="20"');
    const capped = field("shoulder.capped");
    expect(capped).toContain('type="checkbox"');
    expect(capped).toContain('aria-label="Capped"');
    expect(capped).toContain("checked");
    expect(capped).not.toContain("aria-describedby");
  });
});
