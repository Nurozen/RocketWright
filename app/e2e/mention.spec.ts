/**
 * B12/B17: the viewport's `@` puts the selected part into the embedded
 * Lecturn pane's composer (`lecturn/composer.insertMention`): a removable
 * chip with an icon in the strip above the composer input. The old chat's
 * own composer and chips went with B17.
 *
 * On its own copy of the seeded research vehicle and its own Lecturn dirs
 * (`aux-project.ts`): the
 * pane needs a thread for its composer (made here from the rail's New
 * thread), and a Lecturn thread on the shared project would open in every
 * later spec's pane and take the keyboard focus from their field edits.
 */
import { expect, test, type Page } from "@playwright/test";
import { auxProject, type AuxProject } from "./aux-project.ts";
import { lecturnEnv, type LecturnEnv } from "./lecturn-env.ts";
import { PROJECT_NAME, SEEDED_ENV } from "./live.ts";
import { paneComposer, WEB } from "./viewport-helpers.ts";

const label = (page: Page, id: string) => page.locator(`[data-testid="vp.leader-label"][data-part="${id}"]`);

let aux: AuxProject;
let lecturn: LecturnEnv;

test.beforeAll(async () => {
  const seeded = process.env[SEEDED_ENV];
  if (!seeded) throw new Error(`${SEEDED_ENV} is not set (the Playwright global setup seeds it)`);
  // Its own Lecturn dirs (temp, never ~/.lecturn): the shared server's sidecar owns the global pair.
  lecturn = lecturnEnv(process.env, "rw-e2e-mention-lecturn-", { fresh: true });
  aux = await auxProject(seeded, PROJECT_NAME, { LECTURN_HOME: lecturn.env["LECTURN_HOME"]!, RW_LECTURN_BASE_DIR: lecturn.env["RW_LECTURN_BASE_DIR"]! });
});

test.afterAll(async () => {
  await aux?.stop();
  lecturn?.cleanup();
});

test("the selected part's @ lands in the embedded pane's composer strip as a chip with an icon", async ({ page }) => {
  await page.goto(`${WEB}?rpc=${encodeURIComponent(aux.rpc)}&http=${encodeURIComponent(aux.http)}&page=01`);
  await page.waitForFunction(() => (window as { __rwShell?: { status: string } }).__rwShell?.status === "ready");
  await expect(page.getByTestId("viewport")).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
  const guest = await paneComposer(page);
  for (const part of ["airframe", "nose"]) {
    await label(page, part).click();
    await expect(page.getByTestId("vp.mention")).toHaveAttribute("data-part", part);
    await page.getByTestId("vp.mention").click();
    const chip = guest.locator(`[data-testid="app-ref-chip"][data-app-ref="rw:c/${part}"]`);
    await expect(chip).toHaveCount(1, { timeout: 30_000 });
    // The part's thumbnail when it fits Lecturn's icon cap, else the app icon.
    await expect(chip.locator("img")).toHaveAttribute("src", /^data:image\//);
  }
});
