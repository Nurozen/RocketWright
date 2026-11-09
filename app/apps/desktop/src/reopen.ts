/**
 * R0.1: reopening the last project (seam 1), Electron-free. Main runs this
 * after its RPC connects and before it creates the window, so the page finds
 * the project in `project.list` and Welcome never flashes.
 *
 * Bounded below the 120 s RPC default: past it the window comes up on Welcome
 * with a notice rather than hanging on a stalled folder. A late `project.open`
 * still lands on the server, which dedupes a Recent click joining it.
 *
 * Nothing here throws: a project that cannot reopen must never stop the app
 * starting. The page pulls the result as `DesktopBoot`.
 */
import type { DesktopBoot, ProjectInfo } from "@rw/contracts";
import type { LastActive } from "./recents.ts";

export const REOPEN_TIMEOUT_MS = 20_000;

export interface ReopenDeps {
  pickLastActive(): Promise<LastActive | null>;
  /** `project.open` on the app server (main's RPC). */
  openProject(dir: string): Promise<ProjectInfo>;
  /** A cold `rocketwright://open` link is waiting: it picks the project instead. */
  linkPending(): boolean;
  timeoutMs?: number;
  log?: (line: string) => void;
}

const NOTHING: DesktopBoot = { activeProjectId: null, notice: null };

const failed = (notice: string): DesktopBoot => ({ activeProjectId: null, notice });

/** Why `last` was not opened; null when it can be. */
function refusal({ dir, status }: LastActive): DesktopBoot | null {
  switch (status) {
    case "ok":
      return null;
    case "missing":
      return failed(`${dir} no longer exists, so RocketWright could not reopen it.`);
    case "denied":
      return failed(`RocketWright could not read ${dir}. Check that it may open that folder, then open it from Recent.`);
    case "locked":
      return failed(`${dir} is open in another RocketWright or agent session. Close it there, then open it from Recent.`);
  }
}

/** The server's reason, without `MainRpcError`'s method and code prefix. */
const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/^project\.open: \w+: /, "");

async function attempt(deps: ReopenDeps): Promise<DesktopBoot> {
  const last = await deps.pickLastActive();
  if (last === null) return NOTHING;
  const refused = refusal(last);
  if (refused !== null) return refused;
  try {
    const project = await deps.openProject(last.dir);
    return { activeProjectId: project.projectId, notice: null };
  } catch (e) {
    return failed(`Could not reopen ${last.dir}: ${reason(e)}`);
  }
}

/** Opens the last-active project if it can; what the page shows first comes back as `DesktopBoot`. */
export async function reopenLast(deps: ReopenDeps): Promise<DesktopBoot> {
  if (deps.linkPending()) return NOTHING;
  const timeoutMs = deps.timeoutMs ?? REOPEN_TIMEOUT_MS;
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<DesktopBoot>((ok) => {
    timer = setTimeout(() => ok(failed("Reopening your last project took too long. Open it from Recent to try again.")), timeoutMs);
  });
  try {
    const boot = await Promise.race([attempt(deps), expired]);
    if (boot.notice !== null) deps.log?.(`reopen: ${boot.notice}`);
    return boot;
  } catch (e) {
    deps.log?.(`reopen: ${reason(e)}`);
    return NOTHING;
  } finally {
    clearTimeout(timer);
  }
}
