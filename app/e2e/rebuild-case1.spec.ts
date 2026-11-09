/**
 * B1: rebuild case 1 through visible human controls on a clean profile, in the
 * Electron app, with no `--project`: the launch a person makes. Which stages
 * run is `B1_STAGES` (`case1-stages.ts`); each row's status lands in
 * `target/bar/e2e/b1/progress.json` and each launch's trace beside it.
 *
 * This file is source-scanned with the drive (D27). Launching, quitting and
 * reading what quit left behind live in `case1-lifecycle.ts`.
 */
import { expect, test } from "@playwright/test";
import { startCase1Run, stopCase1Run, type Case1Run } from "./case1-lifecycle.ts";
import { buildProgress, writeProgress } from "./case1-progress.ts";
import { boundRows } from "./case1-script.ts";
import { B1_STAGES, runStages, type DriveContext, type RowStatus } from "./case1-stages.ts";

/** The name the script types in the New project dialog (`fixtures/case1`). */
const PROJECT_NAME = "A simple model rocket";

test.describe("B1 rebuild case 1", () => {
  let run: Case1Run | undefined;

  test.afterEach(async () => {
    await stopCase1Run(run);
  });

  test("a person makes a project, quits, and finds it again", async () => {
    // Two cold starts of the app, its sidecar and Lecturn's.
    test.setTimeout(360_000);
    run = await startCase1Run(PROJECT_NAME);
    const rows = boundRows();
    const statuses = new Map<string, RowStatus>();
    const ctx: DriveContext = {
      page: run.page,
      expect,
      lifecycle: run.lifecycle,
      statuses,
      added: new Set(),
      timeouts: { row: 15_000, launch: 120_000, run: 180_000 },
      timing: {},
      tableReads: [],
    };
    try {
      await runStages(ctx, B1_STAGES, rows);
    } finally {
      writeProgress(buildProgress(rows, statuses, B1_STAGES));
    }
    // A Design tab alone would pass on any project: this must be the one made above.
    await expect(ctx.page.getByRole("button", { name: PROJECT_NAME })).toBeVisible({ timeout: ctx.timeouts.row });
  });
});
