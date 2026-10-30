/**
 * RocketWright's Lecturn app registration (spec W2.1, plan B8; Lecturn
 * `AppRegistration`). Lecturn pins a grant to these fields: changing any of
 * them (the binary path, `embedOrigins`, the instructions) asks the user to
 * approve RocketWright again.
 *
 * - `headlessTools` runs the same `rocketwright` binary as the app's own rw
 *   sidecar (`RW_SIDECAR_BIN`, Makefile `RW_PLAIN_BIN`), so both share one
 *   lock protocol: Lecturn's call path is `rocketwright mcp --project <root>`
 *   (an owner or a relay, D4), and it refreshes definitions only through the
 *   lock-free `listArgs` (`mcp --list-tools`, decision 11).
 * - `embedOrigins`: any loopback port (D9). Plain-web dev and `vite preview`
 *   bind port 0, and a changed origin would need re-approval.
 * - `gatedTools: []`: every gate is app-decided (`_meta["lecturn/approval-required"]`, W1.3).
 * - `instructions`: the old runtime block (`agent/runtimePrompt.ts`) rewritten
 *   for any provider, with the agent-visible `rw_<tool>` names (W2.2). rw:
 *   refs are plain text there (CPW2A): agents copy the style, and Lecturn
 *   renders inline code literally, so a backticked ref shows no chip.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import type { ConnectOptions } from "@lecturn/embed/node";
import { sidecarBinary } from "../sidecar/SidecarClient.ts";

export type AppRegistration = ConnectOptions["registration"];

export const RW_APP_ID = "dev.rocketwright.app";
export const RW_APP_NAME = "RocketWright";
/** Agent-visible names are `rw_<tool>` (Claude: `mcp__lecturn__rw_<tool>`). */
export const RW_LECTURN_TOOL_PREFIX = "rw";
export const RW_OPEN_URL_TEMPLATE = "rocketwright://open?workspace={workspaceRoot}&thread={threadId}";
export const RW_REF_PREFIXES = ["rw:"] as const;
export const RW_EMBED_ORIGINS = ["http://127.0.0.1:*"] as const;
/** Lecturn's caps: a PNG of at most 64 KB, instructions of at most 8 KB (UTF-8). */
export const ICON_MAX_BYTES = 64 * 1024;
export const INSTRUCTIONS_MAX_BYTES = 8 * 1024;

/** `app/apps/desktop/assets/app-icon-128.png` (this file is `app/apps/server/src/lecturn/`). */
export const APP_ICON_PATH = resolve(import.meta.dirname, "../../../desktop/assets/app-icon-128.png");

/** Provider-neutral: no `mcp__*` names, nothing that assumes a Claude host. */
export const RW_LECTURN_INSTRUCTIONS = [
  "# RocketWright",
  "This thread belongs to a RocketWright project: its workspace root is the project directory, and the RocketWright tools are named rw_<tool>.",
  "- Write rw: references as plain text (rw:c/fins), never inside backticks or code blocks, so they render as links. Tool names, file names and field names need no code formatting either.",
  "- Example reply: The fins rw:c/fins now span 50 mm, and rw_design_check passes with no errors.",
  "- rocketwright.toml (project settings), rocket.rw.toml (the rocket: params and components, with included files under parts/), and the configs, sims and engines folders (*.rw.toml) are the canonical model. Everything else (renders, runs, the 3D view) is derived from them.",
  "- Change the model only through the RocketWright tools (rw_model_patch, rw_component_add, rw_component_remove, ...), never by editing the files directly. Use dry_run: true to preview a change.",
  "- Run the design check after every edit: call rw_design_check and read the diagnostics and the check delta. Fix errors before moving on.",
  "- Never claim an edit, a design, or a simulation succeeded without a passing rw_design_check (and, for simulations, a complete run) to back it.",
  "- For visual confirmation use rw_render (deterministic drawings and 3D views) or rw_viewport_render (the live viewport the user sees in RocketWright); rw_plot_render shows a Results plot.",
  "- rw: refs (rw:c/fins, rw:run/<id>) name components, configs, sims, runs, and steps. Mentioned refs arrive as chips in the user's message; read their current values with rw_model_get before relying on them.",
  "- rw_simulate returns a job_id; poll rw_job_status until it is complete or failed. rw_engine_simulate returns the finished run.",
  "- Imports, exports, network fetches, and large jobs may need the user's approval. If a call is refused or not approved, do not retry it unless the user asks.",
  "- The motor library is built in and works offline. Only when the user asks for ThrustCurve, or for a real motor the library lacks, search thrustcurve.org with rw_thrustcurve_search, then download one motor file into lib/motors with rw_thrustcurve_fetch (it needs the user's approval). Assign its lib: ref and check. Never reach the network otherwise.",
].join("\n");

/** `data:image/png;base64,…` of `path`; throws unless it is a PNG of at most 64 KB. */
export function iconDataUrl(path: string = APP_ICON_PATH): string {
  const png = readFileSync(path);
  if (png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error(`${path}: not a PNG`);
  if (png.length > ICON_MAX_BYTES) throw new Error(`${path}: ${png.length} bytes, over Lecturn's ${ICON_MAX_BYTES}-byte icon cap`);
  return `data:image/png;base64,${png.toString("base64")}`;
}

/**
 * The absolute `rocketwright` the app's own sidecar runs (`sidecarBinary`:
 * `RW_SIDECAR_BIN`, else `rocketwright` on PATH), as Lecturn requires an
 * absolute `headlessTools.command`.
 */
export function absoluteSidecarBinary(bin: string = sidecarBinary(), env: NodeJS.ProcessEnv = process.env): string {
  if (isAbsolute(bin)) return bin;
  if (bin.includes("/")) return resolve(bin);
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (dir === "") continue;
    const candidate = join(dir, bin);
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return resolve(candidate);
    } catch {
      // unreadable PATH entry: keep looking
    }
  }
  throw new Error(`${bin}: not found on PATH (set RW_SIDECAR_BIN to the rocketwright binary)`);
}

export interface RegistrationOptions {
  /** Absolute `rocketwright` path (default: `absoluteSidecarBinary()`). */
  bin?: string;
  /** Icon PNG (default: `APP_ICON_PATH`). */
  iconPath?: string;
}

export function rocketwrightRegistration(opts: RegistrationOptions = {}): AppRegistration {
  const command = opts.bin ?? absoluteSidecarBinary();
  if (!isAbsolute(command)) throw new Error(`headlessTools.command must be absolute: ${command}`);
  if (Buffer.byteLength(RW_LECTURN_INSTRUCTIONS) > INSTRUCTIONS_MAX_BYTES) throw new Error("instructions exceed Lecturn's 8 KB cap");
  return {
    appId: RW_APP_ID,
    name: RW_APP_NAME,
    iconDataUrl: iconDataUrl(opts.iconPath),
    toolPrefix: RW_LECTURN_TOOL_PREFIX,
    openUrlTemplate: RW_OPEN_URL_TEMPLATE,
    refPrefixes: [...RW_REF_PREFIXES],
    headlessTools: {
      command,
      args: ["mcp", "--project", "{workspaceRoot}"],
      listArgs: ["mcp", "--list-tools", "--project", "{workspaceRoot}"],
      cwd: "{workspaceRoot}",
    },
    liveTools: true,
    gatedTools: [],
    embedOrigins: [...RW_EMBED_ORIGINS],
    instructions: RW_LECTURN_INSTRUCTIONS,
  };
}
