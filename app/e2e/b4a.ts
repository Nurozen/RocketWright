/** B4(a) constants shared by `b4a.spec.ts` and the fixture unit test (M1.18, B14). */
import { join } from "node:path";
import { REPO_ROOT } from "./bar/paths.ts";

/** The user message from spec S:198. */
export const B4A_PROMPT = "set fin span to 90 mm and rerun Baseline";
/** The scripted turn (`embed.ts` `ScriptedTurnFixture`) Lecturn's scripted provider replays (B14, D22). */
export const B4A_FIXTURE = "b4a";
export const B4A_SCRIPT = join(REPO_ROOT, "app/e2e/fixtures/scripted/b4a.json");
/** The Lecturn thread the spec creates in the pane. */
export const B4A_THREAD_TITLE = "B4(a) fin span";
/** The Playwright test title the scoreboard looks up in the JSON report. */
export const B4A_TITLE = "set fin span to 90 mm and rerun Baseline";
export const B4A_SPEC_FILE = "b4a.spec.ts";
