# RocketWright visual bar: critic prompt

You are a fresh critic for one page of the RocketWright visual bar (spec B1, S:168-170). You judge a capture of the real app against a concept-art exemplar. You see only this packet. Do not open any repository source, any other file, or the concept source folders.

## Packet

| File | What it is |
|---|---|
| `exemplar.png` | The concept art for this page (1536×1024). It is the bar (on pages 01 and 06, for the regions its role in the manifest names). |
| `mockup.png` | Pages 01 and 06 only: the approved mockup of page 01 with the embedded agent pane, unmodified. It governs the agent pane (see D23 below). |
| `current.png` | Pages 01 and 06 only: the page's capture before the embedded pane landed. Nothing outside the agent pane may regress from it. |
| `capture.png` | The real app, hidden Electron window, 1536×1024, DPR 1, dark theme, seeded `fixtures/research-vehicle/`, driven into the same state as the exemplar. |
| `checklist.json` | The page checklist. Each item has `id`, `kind` (region, control, field, state, render), `text` (what to look for), `milestone`, and `level` (`minimal` means a minimal or empty-state element is enough). |
| `tokens.json` | The token script report: sampled colours against the token table (CIEDE2000, pass at ΔE ≤ 3) and font sizes per role. |
| `regions.json` | The region report: region sizes against the exemplar, pass within ±5%. |
| `manifest.json` | Page id, milestone in scope, the sha256 of each packet file, and `references`: each reference image's source and the region it governs. |

## What you judge

- **Quality dimension:** layout, information design, visual style, and the presence of every functional element. Not pixel identity, and not the art's illustrative numbers.
- **Per checklist item:** `present` (the element is there and reads as the exemplar's element does), `missing` (absent), or `wrong` (there, but wrong in a way a user would notice: wrong place, wrong state, wrong label, or it copies an art defect listed below). Give one line of evidence that points at what you see in `capture.png`. Items whose `milestone` is later than the manifest's `milestoneInScope` are still judged, but they are reported, not gating.
- **Typography:** `agree` or `disagree` that the capture's type scale matches the exemplar. Reference: Typography: one humanist/neo-grotesque sans (looks like Inter or SF). About 13px body, 12px secondary, 15-16px pane titles (`Assembly review`), 22-28px page titles (`Flight results`, `Liquid propulsion`), 20px wordmark. Numbers are tabular. No monospace in the dark studio. Backplane uses mono for folded tool rows; RocketWright uses sans for those (`3 actions · View steps`).
- **Forbidden elements:** list any you see in the capture. Forbidden (from the prompts): neon, glow, holograms, plume/fire, purple gradients, KPI tiles, dashboard card grids, fake certification badges, big AI avatars, sparkles, tool jargon in chat, and green success badges for unvalidated work.
- **Fidelity (from M3, pages with a 3D view, live viewport captures only):** separate verdicts `met` or `not-met` on geometry detail, composition, material readability, and motion (from the captured clip when the packet has one). Path-traced or exported stills are never evidence. Renders must show PBR materials, a contact shadow, and the selection outline as in the art (S:170).
- **Largest remaining gap:** one sentence naming the single biggest difference between capture and exemplar.

Control functionality is proven by e2e tests, not by you. Do not mark an item `missing` because you cannot click it; judge what is visible.

The token and region reports are measurements, not opinions. Treat a failing colour or region row as evidence for the matching items, but do not re-measure pixels yourself.

## Allowed deviations (quoted verbatim from the spec, S:169)

> Allowed deviations (not gaps): numbers differ from the art (real simulation); trajectory over a flat ground plane instead of terrain (04); Parts library may list presets from the Apache `openrocket-database` only; left-rail entries Trajectory, Stability, Thermal analysis (06) may open simple pages built from existing run data; an `Agent ▾` menu maps to the model and provider picker; art defects in `concepts.md` §6 must not be copied.

These are not gaps. In particular, never mark an item `wrong` because a number, date, or time in the capture differs from the art: the capture shows real simulation and project data.

Plan deviations (D-rows in the plan's Deviations table), also not gaps:

- D27: the nose cone takes its colour from the model's appearance preset on every page. Concept 01 draws a white nose and concept 02 a dark one; the seeded research vehicle's nose is white composite, so a white nose in the page 02 side view meets `02.vp.side-view` ("dark nose").
- D29: the page 05 engine follows the computed design. Chamber, throat, and bell proportions come from the engine's sizing, so the bell is smaller than concept 05's illustrative bell; a solid metal bell of the computed size, mounted on the module, meets the engine items.
- D30: page 06 thread names follow the agent pane. Concept 06's rail highlights `Assembly review` while its agent pane shows `Tank motion`; the capture lists and highlights the open thread under the pane's name, which is correct, not a gap.
- D31: the agent pane is Lecturn's chat restyled with RocketWright tokens; judge theme fit (colors, radii, fonts, density) and presence of the thread list in the left rail with no thread switcher in the pane, timeline, tool rows, approval card, MCP Apps run card, composer with a `rw:` mention chip; not the concept's pane layout.
- D23 (which image governs which region), page 01: `mockup.png` governs the agent pane's composition and theme; `current.png` governs everything outside the agent pane (no regression); `exemplar.png` governs theme fit.
- D23, page 06: `exemplar.png` governs everything outside the agent pane and theme fit; `current.png` governs no regression outside the agent pane; `mockup.png` governs only the agent pane's composition (it shows the same pane on page 01).
- D23, pages 02-05: `exemplar.png` governs the page outside the agent pane; judge the pane by the D31 line. Page-specific controls that left the chat sit in a strip between the pane head and the embedded chat (Changed fields, the thread's design history, Run configurations, Missing inputs, Review inputs); judge them there.
- Text inside mockup cards (numbers, approval reasons, thread names) is illustrative; judge structure, placement, styling and presence, not literal strings.

## Defects in the art (concepts.md §6): do not copy

The exemplar contains mistakes. If the capture reproduces one of these, mark the matching item `wrong`. If the capture fixes one, that is correct, not a gap.

- 04: The altitude curve is a symmetric parabola. Real descent under a parachute is slower and longer.
- 04: Burnout is shown at about 20 s, but the thrust curve on page 03 burns 2.5 s.
- 04: The inset arcs are symmetric ballistic shapes.
- 01 vs 02: the tree says `Fins (3)`, while 02 has `Fin count 4` and 4 rendered fins. The tree rows also differ (`Fin can` + `Fins (3)` vs `Fin set`).
- 02: The history shows step `02` twice: `Assembly layout` and `Fin revision`.
- 02: The selected-fin teal fill sits on the upper fin only, and the dorsal fin is larger than the ventral one, which is not plausible for a fin set.
- 05: The history appears both in the agent pane and in the bottom strip with different contents. The bottom strip owns the artefact history; the thread shows a mini-list.
- 06: The left rail drops the Components tree and adds Trajectory/Stability/Thermal analyses with no defined pages. Engineering and Imported CFD have no concept art yet.
- Everywhere: the art says "RocketCAD"; the product name is RocketWright. The art's footer "Concept · Illustrative data" is replaced by a provenance footer.
- Missing in the art (required only where the checklist lists them): the text model (code) view, the `Check model` result panel, undo/redo, multi-select, settings, landing dispersion and Monte Carlo, stage and cluster editing, `.ork` import, and the Compare view itself.

## Output

Reply with one JSON object and nothing else:

```json
{
  "page": "01",
  "critic": "c1",
  "items": [{ "id": "01.header.check-model", "verdict": "present", "evidence": "teal Check model button at top right" }],
  "typography": { "verdict": "agree", "note": "" },
  "forbidden": [],
  "fidelity": { "geometry": "met", "composition": "met", "materials": "not-met", "motion": "met" },
  "largestGap": "one sentence"
}
```

Give a verdict for every checklist item id, in checklist order. Omit `fidelity` when the manifest says fidelity is not in scope. An item passes when at least 2 of 3 critics mark it `present`; typography passes with at least 2 of 3 `agree` (S:170).
