import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { calibrate, lintSpecData } from "../bar/calibrate.ts";
import {
  PLANTED,
  checkPostFreezeCommits,
  deviationSectionDRows,
  lintChecklists,
  lintCriticPrompt,
  lintItem,
  loadLintContext,
  parseArtNumbers,
  parseFrozen,
  planDRows,
  postFreezeCommits,
  renderFrozen,
  selfTest,
} from "../bar/lint-checklists.ts";
import { CHECKLIST_DIR, CRITIC_PROMPT_PATH, PAGES, exemplarDir } from "../bar/paths.ts";
import { decodePng, encodePng, fillRect, solidImage } from "../bar/png.ts";
import { loadChecklists, loadRegions, loadTokens, type ChecklistItem } from "../bar/spec.ts";
import { checkProportions, findEdge } from "../regions.ts";
import { measureImage } from "../visual-tokens.ts";

const tokens = loadTokens();
const regions = loadRegions();
const ctx = loadLintContext();
const checklists = loadChecklists();

function exemplarsAvailable(): boolean {
  try {
    return existsSync(join(exemplarDir(), "01-assembly.png"));
  } catch {
    return false;
  }
}

describe("png codec", () => {
  it("round-trips RGBA", () => {
    const img = solidImage(7, 5, [10, 20, 30]);
    fillRect(img, [2, 1, 3, 2], [200, 100, 50]);
    const back = decodePng(encodePng(img));
    expect(back.width).toBe(7);
    expect(back.height).toBe(5);
    expect(Buffer.from(back.data).equals(Buffer.from(img.data))).toBe(true);
  });

  it("is deterministic and rejects non-PNG bytes", () => {
    const img = solidImage(4, 4, [1, 2, 3]);
    expect(Buffer.from(encodePng(img)).equals(Buffer.from(encodePng(img)))).toBe(true);
    expect(() => decodePng(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow(/signature/);
  });

  it.skipIf(!exemplarsAvailable())("decodes a filtered RGB exemplar", () => {
    const img = decodePng(readFileSync(join(exemplarDir(), "01-assembly.png")));
    expect([img.width, img.height]).toEqual([1536, 1024]);
  });
});

describe("region detection", () => {
  it("finds a hairline near the expected edge and prefers the nearest of a 2 px line", () => {
    const img = solidImage(100, 50, [27, 30, 32]);
    fillRect(img, [40, 0, 2, 50], [50, 56, 62]);
    expect(findEdge(img, "x", 42, 6, 0, 50)).toBe(41);
    expect(findEdge(img, "x", 40, 6, 0, 50)).toBe(40);
    expect(findEdge(img, "x", 70, 6, 0, 50)).toBeNull();
  });

  it("fails a missing region", () => {
    const r = checkProportions(regions, "04", {});
    expect(r.length).toBeGreaterThan(0);
    expect(r.every((p) => !p.pass && p.measured === null)).toBe(true);
  });
});

describe("spec data", () => {
  it("tokens.json and regions.json are internally consistent", () => {
    expect(lintSpecData(tokens, regions)).toEqual([]);
  });

  it("covers the concepts.md §2 token table", () => {
    for (const t of ["bg/canvas", "panel", "line", "text/primary", "text/secondary", "accent/teal", "accent/teal-fill", "selection/row", "bubble/user", "series-b", "series-b/row", "amber/ghost", "warning", "success", "parachute", "fluid"]) {
      expect(tokens.colors[t], t).toBeDefined();
    }
    expect(tokens.tolerance.deltaE2000).toBe(3);
    expect(regions.tolerance.proportion).toBe(0.05);
    expect(tokens.forbidden).toContain("green success badges for unvalidated work");
  });

  it("names a probe table and region rects for every page", () => {
    for (const p of PAGES) {
      expect(tokens.probes[p]?.length, p).toBeGreaterThan(0);
      expect(Object.keys(regions.pages[p].check).length, p).toBeGreaterThan(0);
    }
  });

  it("detects broken references", () => {
    const bad = structuredClone(tokens);
    bad.bindings.push({ token: "nope", region: "nowhere", property: "color", pages: "*" });
    const errs = lintSpecData(bad, regions);
    expect(errs.some((e) => e.includes("unknown token nope"))).toBe(true);
    expect(errs.some((e) => e.includes("defined region"))).toBe(true);
  });
});

describe.skipIf(!exemplarsAvailable())("calibration on the exemplar PNGs", () => {
  it("every exemplar passes its own token and region tables", () => {
    const { reports, errors } = calibrate(exemplarDir());
    expect(errors).toEqual([]);
    expect(reports.map((r) => r.page)).toEqual([...PAGES]);
  });

  it("a different exemplar does not pass page 04's table (probes are page-specific)", () => {
    const img = decodePng(readFileSync(join(exemplarDir(), "01-assembly.png")));
    expect(measureImage(img, "04", tokens, regions).pass).toBe(false);
  });
});

describe("checklists", () => {
  it("has six draft checklists that pass the lint", () => {
    expect([...checklists.keys()]).toEqual(PAGES.map((p) => `${p}.json`));
    expect(lintChecklists(checklists, ctx)).toEqual([]);
  });

  it("rejects every planted §6 defect and art-number item (self-test)", () => {
    expect(selfTest(checklists, ctx)).toEqual([]);
    for (const { item, expect: re } of PLANTED) {
      expect(lintItem(item, item.id.slice(0, 2), ctx).some((e) => re.test(e)), item.id).toBe(true);
    }
  });

  it("carries the D10 U-items as required", () => {
    const all = [...checklists.values()].flatMap((c) => c.items);
    const by = (id: string): ChecklistItem | undefined => all.find((i) => i.id === id);
    for (const id of [
      "01.vp.axis-gizmo", // U15 gizmo
      "02.vp.ghost", // U8 ghost
      "02.agent.changed-fields", // U8 Changed fields
      "02.editor.revert", // U10 Revert
      "04.history.snapshot-card", // U12 snapshot row
      "04.banner.outdated", // U12 banner
      "01.history.compare", // U13 Compare
      "01.tree.thumbnails", // U14 thumbnails
      "05.page.tabs", // Properties tab
      "05.insp.sources", // Source references
    ]) {
      expect(by(id)?.level, id).toBe("required");
    }
    for (const id of ["03.toolbar.rendering", "01.header.settings", "01.composer.attach", "06.rail.analysis-pages", "01.agent.provenance-footer"]) {
      expect(by(id)?.level, id).toBe("minimal");
    }
  });

  it("tags every item with a milestone, and pages 01/04 structure as M1", () => {
    const c01 = checklists.get("01.json")!;
    const c04 = checklists.get("04.json")!;
    expect(c01.items.filter((i) => i.kind === "region").every((i) => i.milestone === "M1")).toBe(true);
    expect(c04.items.filter((i) => i.kind !== "render").every((i) => i.milestone === "M1")).toBe(true);
    expect(checklists.get("05.json")!.items.some((i) => i.milestone === "M4")).toBe(true);
    expect(checklists.get("06.json")!.items.some((i) => i.milestone === "M5")).toBe(true);
  });

  it("rejects malformed items", () => {
    const base: ChecklistItem = { id: "01.x.y", kind: "control", testid: "x.y", milestone: "M1", source: "C§3", text: "A valid item text.", level: "required" };
    expect(lintItem(base, "01", ctx)).toEqual([]);
    expect(lintItem({ ...base, id: "02.x.y" }, "01", ctx).join()).toMatch(/prefix/);
    expect(lintItem({ ...base, kind: "widget" as never }, "01", ctx).join()).toMatch(/kind/);
    expect(lintItem({ ...base, milestone: "M9" as never }, "01", ctx).join()).toMatch(/milestone/);
    expect(lintItem({ ...base, kind: "region", testid: "not-a-region" }, "01", ctx).join()).toMatch(/not a region/);
    expect(lintItem({ ...base, source: "vibes" }, "01", ctx).join()).toMatch(/source/);
    expect(lintItem({ ...base, extra: 1 } as never, "01", ctx).join()).toMatch(/keys/);
    expect(lintItem({ ...base, text: "Steps show 02 Assembly layout then 02 Fin revision." }, "01", ctx).join()).toMatch(/02-step-02-twice/);
    expect(lintItem({ ...base, text: "Selected flow path glows teal." }, "01", ctx).join()).toMatch(/forbidden-styling/);
  });

  it("reports a missing region item, a duplicate id, and a missing page", () => {
    const copy = new Map(checklists);
    const c01 = copy.get("01.json")!;
    copy.set("01.json", { ...c01, items: [...c01.items.filter((i) => i.testid !== "inspector"), c01.items[0]!] });
    copy.delete("06.json");
    const errs = lintChecklists(copy, ctx).join("\n");
    expect(errs).toMatch(/region 'inspector' has an exemplar rect but no region item/);
    expect(errs).toMatch(/duplicate id/);
    expect(errs).toMatch(/06\.json is missing/);
  });

  it("verifies FROZEN.sha256 hashes when frozen", () => {
    const raw = new Map([...checklists.keys()].map((f) => [f, readFileSync(join(CHECKLIST_DIR, f))]));
    const lines = [...raw].map(([f, b]) => `${createHash("sha256").update(b).digest("hex")}  ${f}`);
    const frozen = parseFrozen(lines.join("\n"));
    expect(lintChecklists(checklists, { ...ctx, frozen }, raw)).toEqual([]);
    const tampered = new Map(raw);
    tampered.set("01.json", Buffer.concat([raw.get("01.json")!, Buffer.from(" ")]));
    expect(lintChecklists(checklists, { ...ctx, frozen }, tampered).join()).toMatch(/changed after the BC0 freeze/);
  });

  it("renders a sorted sha256sum manifest and flags stale FROZEN entries", () => {
    const raw = new Map([...checklists.keys()].map((f) => [f, readFileSync(join(CHECKLIST_DIR, f))]));
    const text = renderFrozen(raw);
    expect(text.trim().split("\n").map((l) => l.split("  ")[1])).toEqual([...raw.keys()].sort());
    const frozen = parseFrozen(text);
    frozen.set("07.json", "0".repeat(64));
    expect(lintChecklists(checklists, { ...ctx, frozen }, raw).join()).toMatch(/lists 07\.json/);
  });

  it("is frozen at BC0 and the committed checklists match FROZEN.sha256", () => {
    expect(existsSync(join(CHECKLIST_DIR, "FROZEN.sha256"))).toBe(true);
    const raw = new Map([...checklists.keys()].map((f) => [f, readFileSync(join(CHECKLIST_DIR, f))]));
    expect(lintChecklists(checklists, ctx, raw)).toEqual([]);
  });
});

describe("post-freeze D-row rule (D23)", () => {
  it("requires a D-row id in every post-freeze checklist commit", () => {
    const known = planDRows("| D10 | x |\n| D23 | y |\n| Q6 | z |\n");
    expect([...known].sort()).toEqual(["D10", "D23"]);
    expect(checkPostFreezeCommits([{ sha: "a".repeat(40), message: "M2.3: retag 02 items (D23)" }], known)).toEqual([]);
    expect(checkPostFreezeCommits([{ sha: "b".repeat(40), message: "tweak checklist wording" }], known).join()).toMatch(/without a D-row id/);
    expect(checkPostFreezeCommits([{ sha: "c".repeat(40), message: "retag per D99" }], known).join()).toMatch(/none of which is a plan D-row/);
    expect(checkPostFreezeCommits([{ sha: "c".repeat(40), message: "retag per D99" }])).toEqual([]);
    expect(checkPostFreezeCommits([{ sha: "d".repeat(40), message: "see PD23 and D23x" }]).join()).toMatch(/without a D-row id/);
  });

  it("accepts D-ids named in a follow-on plan's Deviations section (D31, the embed re-lock)", () => {
    const plan = "# Plan\n\n## Deviations from spec\n\n- **D8. Card actions.** x\n  - The D31 record lists every row.\n\n## Phases\n\n- D99 is not a deviation here.\n";
    expect([...deviationSectionDRows(plan)].sort()).toEqual(["D31", "D8"]);
    expect(deviationSectionDRows("# no section\n- **D1.** x\n").size).toBe(0);
    const known = new Set(["D23", ...deviationSectionDRows(plan)]);
    expect(checkPostFreezeCommits([{ sha: "e".repeat(40), message: "B15: embed checklist rewrite (D31)" }], known)).toEqual([]);
  });

  it("reads post-freeze checklist commits from git history", () => {
    const repo = mkdtempSync(join(tmpdir(), "rw-freeze-"));
    const g = (...args: string[]): string =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], {
        cwd: repo,
        encoding: "utf8",
      });
    const dir = join(repo, "tests/bar/checklists");
    mkdirSync(dir, { recursive: true });
    g("init", "-q");
    writeFileSync(join(dir, "01.json"), "{}\n");
    g("add", ".");
    g("commit", "-qm", "M1.15: draft checklists");
    expect(postFreezeCommits(repo).note).toMatch(/not committed yet/);
    writeFileSync(join(dir, "FROZEN.sha256"), "x\n");
    g("add", ".");
    g("commit", "-qm", "M1.15b: freeze");
    expect(postFreezeCommits(repo).commits).toEqual([]);
    writeFileSync(join(dir, "01.json"), "{ }\n");
    g("commit", "-qam", "edit checklist");
    writeFileSync(join(repo, "README.md"), "unrelated\n");
    g("add", ".");
    g("commit", "-qm", "unrelated change");
    writeFileSync(join(dir, "01.json"), "{  }\n");
    g("commit", "-qam", "M2.1: retag\n\nPer D23.");
    const commits = postFreezeCommits(repo).commits!;
    expect(commits.map((c) => c.message.split("\n")[0])).toEqual(["M2.1: retag", "edit checklist"]);
    const errs = checkPostFreezeCommits(commits);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/'edit checklist'.*without a D-row id/);
  }, 30_000); // runs real git commands; slow under host load
});

describe("art-number matching", () => {
  const nums = parseArtNumbers("850 m\n850\nFins (3)\nre:\\b124\\b\n# comment\n\n");
  const hit = (s: string): boolean => nums.some((n) => n.re.test(s));

  it("matches whole tokens only", () => {
    expect(nums).toHaveLength(4);
    expect(hit("apogee 850 m")).toBe(true);
    expect(hit("value 850")).toBe(true);
    expect(hit("1850 m")).toBe(false);
    expect(hit("8501")).toBe(false);
    expect(hit("850.5")).toBe(false);
    expect(hit("tree row fins (3)")).toBe(true);
    expect(hit("124 mm")).toBe(true);
    expect(hit("1240 mm")).toBe(false);
  });
});

describe("critic prompt", () => {
  const prompt = readFileSync(CRITIC_PROMPT_PATH, "utf8");

  it("quotes S:169, lists the §2 forbidden elements, and the §6 defects", () => {
    expect(lintCriticPrompt(prompt, tokens.forbidden, undefined, ["01", "02", "04", "05", "06"])).toEqual([]);
  });

  it("carries the D31 allowance after the D30 line, outside the quoted S:169 line, with the D23 roles and decision 10", () => {
    const lines = prompt.split("\n");
    const d30 = lines.findIndex((l) => l.startsWith("- D30:"));
    const d31 = lines.findIndex((l) => l.startsWith("- D31:"));
    expect(d30).toBeGreaterThan(0);
    expect(d31).toBe(d30 + 1);
    expect(lines[d31]).toContain("thread list in the left rail with no thread switcher in the pane");
    expect(lines[d31]).toContain("composer with a `rw:` mention chip; not the concept's pane layout.");
    const quote = lines.find((l) => l.startsWith("> Allowed deviations (not gaps):"))!;
    expect(quote).not.toContain("D31");
    expect(lines.filter((l) => l.startsWith("- D23"))).toHaveLength(3);
    expect(prompt).toContain("Text inside mockup cards (numbers, approval reasons, thread names) is illustrative; judge structure, placement, styling and presence, not literal strings.");
    for (const f of ["`mockup.png`", "`current.png`"]) expect(prompt).toContain(f);
  });

  it("detects a paraphrased quote and a dropped forbidden element", () => {
    const quote = "Allowed deviations (not gaps): numbers differ from the art (real simulation);";
    expect(lintCriticPrompt(prompt.replace("(real simulation)", "(real sim)"), [], quote, []).join()).toMatch(/not verbatim/);
    expect(lintCriticPrompt(prompt.replace("sparkles", "sparkle"), tokens.forbidden, undefined, []).join()).toMatch(/sparkles/);
  });
});
