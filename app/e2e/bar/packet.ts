/**
 * Builds the critic packet for one page (plan "Critic protocol"): critics get
 * only the packet, never repo source or the concept source folders.
 *
 * Packet files: exemplar.png, capture.png, tokens.json, regions.json,
 * checklist.json, critic-prompt.md, manifest.json (+ motion clip when given).
 * Pages 01 and 06 also carry mockup.png (the approved embedded-chat mockup)
 * and current.png (the page's no-regression capture), and the manifest's
 * `references` names each reference image's source and the region it governs
 * (D23, `PAGE_REFERENCES`).
 *
 * CLI: `node e2e/bar/packet.ts --page 01 --capture <png> --tokens <report.json>
 *   [--regions <report.json>] [--clip <webm|mp4>] [--milestone M1] [--fidelity] [--out <dir>]`
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import type { TokenReport } from "../visual-tokens.ts";
import { CHECKLIST_DIR, CRITIC_PROMPT_PATH, embedAssetsDir, exemplarDir, isPageId, readJson, reviewsDir, stableStringify, type PageId } from "./paths.ts";
import { MILESTONES, loadRegions, type Checklist, type Milestone } from "./spec.ts";

/** Path fragments a packet input may never come from (clean-room rules, builder brief). */
export const DENIED_PATH_FRAGMENTS = [
  "/openrocket/",
  "/references/openMotor/",
  "/references/jsbsim/",
  "/references/openscad/src/",
  "/artifacts/concepts/",
  "/findings/oracle-probe.md",
  "/findings/oracle-only.md",
  "/tmp/orprobe/",
];

/** The packet's reference images: the concept art, the approved mockup, the no-regression capture. */
export type ReferenceFile = "exemplar.png" | "mockup.png" | "current.png";

/** Where a reference image comes from (`exemplars`: the concept art dir; `embed`: the rocketwright-lecturn bar dir) and what it governs. */
export interface ReferenceSpec {
  dir: "exemplars" | "embed";
  source: string;
  role: string;
}

/** The approved mockup of the embedded Lecturn pane (page 01; byte-identical to Lecturn's copy). */
export const EMBED_MOCKUP = "rocketwright-embedded-chat.png";

/**
 * D23: per-page reference images and roles. Pages without an entry get the
 * concept art alone (`regions.json` `pages[page].exemplar`, governing the
 * whole page). The mockup shows page 01; on 06 it governs the pane only.
 */
export const PAGE_REFERENCES: Partial<Record<PageId, Partial<Record<ReferenceFile, ReferenceSpec>>>> = {
  "01": {
    "mockup.png": {
      dir: "embed",
      source: EMBED_MOCKUP,
      role: "Governs the agent pane: its composition (user avatar, tool rows, run card, approval card, chip strip, two-row composer footer) and theme. Unmodified approved mockup.",
    },
    "current.png": {
      dir: "embed",
      source: "current-01-capture.png",
      role: "Governs everything outside the agent pane: no regression from this capture.",
    },
    "exemplar.png": {
      dir: "exemplars",
      source: "01-assembly.png",
      role: "Governs theme fit (palette, density, type) across the page.",
    },
  },
  "06": {
    "exemplar.png": {
      dir: "exemplars",
      source: "06-liquid-simulator.png",
      role: "Governs everything outside the agent pane, and theme fit.",
    },
    "current.png": {
      dir: "embed",
      source: "current-06-capture.png",
      role: "Governs no regression outside the agent pane.",
    },
    "mockup.png": {
      dir: "embed",
      source: EMBED_MOCKUP,
      role: "Governs only the agent pane's composition (the mockup shows the same pane on page 01; nothing outside the pane).",
    },
  },
};

/** The reference images of a page's packet, in a fixed order. */
export function pageReferences(page: PageId, exemplar: string): [ReferenceFile, ReferenceSpec][] {
  const refs = PAGE_REFERENCES[page] ?? { "exemplar.png": { dir: "exemplars", source: exemplar, role: "The concept art for this page: it is the bar." } };
  return (["exemplar.png", "mockup.png", "current.png"] as const).flatMap((f) => (refs[f] === undefined ? [] : [[f, refs[f]] as [ReferenceFile, ReferenceSpec]]));
}

export interface PacketInput {
  page: PageId;
  capture: string;
  tokensReport: string;
  /** Region report; derived from the token report's proportions when absent. */
  regionsReport?: string;
  clip?: string;
  milestone: Milestone;
  fidelity: boolean;
  out: string;
  /** Overrides the exemplar directory (tests). */
  exemplars?: string;
  /** Overrides the embed bar assets directory (mockup, current captures; tests). */
  embedAssets?: string;
}

export interface PacketManifest {
  page: PageId;
  title: string;
  milestoneInScope: Milestone;
  fidelity: boolean;
  files: Record<string, string>;
  /** D23: each reference image's source file and the region it governs. */
  references: Partial<Record<ReferenceFile, { source: string; role: string }>>;
}

export function assertAllowedPath(path: string): void {
  const abs = resolve(path).replaceAll("\\", "/");
  for (const frag of DENIED_PATH_FRAGMENTS) {
    if (abs.includes(frag)) throw new Error(`packet: ${path} is under a clean-room-restricted path (${frag})`);
  }
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function buildPacket(input: PacketInput): PacketManifest {
  const regions = loadRegions();
  const pr = regions.pages[input.page];
  const refs = pageReferences(input.page, pr.exemplar).map(([file, spec]) => ({
    file,
    spec,
    path: join(spec.dir === "exemplars" ? (input.exemplars ?? exemplarDir()) : (input.embedAssets ?? embedAssetsDir()), spec.source),
  }));
  const sources = [...refs.map((r) => r.path), input.capture, input.tokensReport, input.regionsReport, input.clip].filter(
    (p): p is string => p !== undefined,
  );
  for (const p of sources) {
    assertAllowedPath(p);
    if (!existsSync(p)) throw new Error(`packet: missing input ${p}`);
  }
  if (existsSync(input.out) && readdirSync(input.out).length > 0) {
    throw new Error(`packet: output directory ${input.out} is not empty`);
  }
  mkdirSync(input.out, { recursive: true });

  const tokens = readJson<TokenReport>(input.tokensReport);
  if (tokens.page !== input.page) throw new Error(`packet: token report is for page ${String(tokens.page)}, not ${input.page}`);
  const checklist = readJson<Checklist>(join(CHECKLIST_DIR, `${input.page}.json`));

  for (const r of refs) copyFileSync(r.path, join(input.out, r.file));
  copyFileSync(input.capture, join(input.out, "capture.png"));
  copyFileSync(input.tokensReport, join(input.out, "tokens.json"));
  if (input.regionsReport) copyFileSync(input.regionsReport, join(input.out, "regions.json"));
  else {
    writeFileSync(
      join(input.out, "regions.json"),
      stableStringify({ page: input.page, tolerance: tokens.tolerance.proportion, proportions: tokens.proportions }),
    );
  }
  writeFileSync(join(input.out, "checklist.json"), JSON.stringify(checklist, null, 2) + "\n");
  copyFileSync(CRITIC_PROMPT_PATH, join(input.out, "critic-prompt.md"));
  if (input.clip) copyFileSync(input.clip, join(input.out, `motion${extname(input.clip)}`));

  const files: Record<string, string> = {};
  for (const f of readdirSync(input.out).sort()) files[f] = sha256(join(input.out, f));
  const manifest: PacketManifest = {
    page: input.page,
    title: pr.title,
    milestoneInScope: input.milestone,
    fidelity: input.fidelity,
    files,
    references: Object.fromEntries(refs.map((r) => [r.file, { source: r.spec.source, role: r.spec.role }])),
  };
  writeFileSync(join(input.out, "manifest.json"), stableStringify(manifest));
  return manifest;
}

function main(argv: string[]): number {
  const arg = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const page = arg("--page");
  const capture = arg("--capture");
  const tokensReport = arg("--tokens");
  const milestone = (arg("--milestone") ?? "M1") as Milestone;
  if (!page || !isPageId(page) || !capture || !tokensReport || !MILESTONES.includes(milestone)) {
    console.error("usage: node e2e/bar/packet.ts --page 01..06 --capture <png> --tokens <report> [--regions <report>] [--clip <file>] [--milestone M1..M5] [--fidelity] [--out <dir>]");
    return 2;
  }
  const base = reviewsDir();
  const out = arg("--out") ?? (base ? join(base, "visual", `${page}.critics`, "packet") : undefined);
  if (!out) {
    console.error("packet: pass --out <dir> (no maintainer artifacts/ directory above the repo)");
    return 2;
  }
  const regionsReport = arg("--regions");
  const clip = arg("--clip");
  const manifest = buildPacket({
    page,
    capture,
    tokensReport,
    milestone,
    fidelity: argv.includes("--fidelity"),
    out,
    ...(regionsReport ? { regionsReport } : {}),
    ...(clip ? { clip } : {}),
  });
  console.log(`packet ${basename(out)}: ${Object.keys(manifest.files).join(", ")} -> ${out}`);
  return 0;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
