/**
 * The part editor's action row and the Add part popover at the minimum window
 * width, in a real browser: layout a unit test cannot see. The editor is a
 * fixed height, so a tall tab has to scroll its fields and never its actions.
 */
import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";
import { auxProject, REPO, type AuxProject } from "./aux-project.ts";

const WEB = process.env["RW_E2E_WEB_URL"] ?? "";
let aux: AuxProject;

// Each test gets its own copy: the tall tab is made by adding a fin tab, which the project keeps.
test.beforeEach(async () => {
  aux = await auxProject(join(REPO, "fixtures/research-vehicle"), "Research vehicle");
});

test.afterEach(async () => {
  await aux?.stop();
});

async function open(page: Page, width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.goto(`${WEB}?rpc=${encodeURIComponent(aux.rpc)}&http=${encodeURIComponent(aux.http)}&page=02`);
  await page.waitForFunction(() => (window as { __rwShell?: { status: string } }).__rwShell?.status === "ready");
  await expect(page.getByTestId("editor")).toHaveAttribute("data-part", "fins");
}

/** Every corner of the control is what a pointer would hit there: nothing clips or covers it. */
function fullyHit(page: Page, name: string): Promise<boolean> {
  return page.evaluate((label) => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('[data-testid="editor.foot"] button')].find((b) => b.textContent?.trim() === label);
    if (button === undefined) return false;
    const r = button.getBoundingClientRect();
    const inset = 2;
    return [
      [r.left + inset, r.top + inset],
      [r.right - inset, r.top + inset],
      [r.left + inset, r.bottom - inset],
      [r.right - inset, r.bottom - inset],
    ].every(([x, y]) => document.elementFromPoint(x!, y!)?.closest("button") === button);
  }, name);
}

for (const [width, height] of [
  [1024, 768],
  [1536, 1024],
] as const) {
  test(`at ${width}x${height} a tall tab scrolls its fields and keeps its actions`, async ({ page }) => {
    await open(page, width, height);
    expect(await fullyHit(page, "Parts library")).toBe(true);
    expect(await fullyHit(page, "Revert change")).toBe(true);

    await page.getByRole("button", { name: "Add fin tab" }).click();
    const scroll = page.getByTestId("editor.scroll");
    await expect(page.getByRole("group", { name: /fin tab/i })).toBeVisible();
    await expect.poll(() => scroll.evaluate((e) => e.scrollHeight > e.clientHeight)).toBe(true);
    expect(await fullyHit(page, "Parts library")).toBe(true);
    expect(await fullyHit(page, "Revert change")).toBe(true);

    // The last field comes into view above the actions, and they stay put.
    await scroll.evaluate((e) => e.scrollTo(0, e.scrollHeight));
    const lastBottom = await page.locator('[data-testid="editor.scroll"] [data-testid="editor.field"]').last().evaluate((e) => e.getBoundingClientRect().bottom);
    const scrollBottom = await scroll.evaluate((e) => e.getBoundingClientRect().bottom);
    expect(lastBottom).toBeLessThanOrEqual(scrollBottom);
    expect(await fullyHit(page, "Parts library")).toBe(true);
    expect(await fullyHit(page, "Revert change")).toBe(true);
  });
}

test("at the minimum width Add part opens beside the tree with its button outlined", async ({ page }) => {
  await open(page, 1024, 768);
  const plus = page.getByRole("button", { name: "Add part", exact: true });
  await expect(plus).toHaveAttribute("aria-expanded", "false");
  await plus.click();
  const dialog = page.getByRole("dialog", { name: "Add part" });
  await expect(dialog).toBeVisible();
  await expect(plus).toHaveAttribute("aria-expanded", "true");
  const rail = await page.getByTestId("left-rail").boundingBox();
  const box = await dialog.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(rail!.x + rail!.width);
  expect(box!.x + box!.width).toBeLessThanOrEqual(1024);
  // Beside its button, not at the top of the window.
  const button = await plus.boundingBox();
  expect(box!.y).toBe(button!.y);
  await expect(page.locator(".rw-ui-popover__caret")).toBeVisible();
  const outline = await plus.evaluate((b) => {
    const s = getComputedStyle(b);
    return `${s.outlineStyle} ${s.outlineColor}`;
  });
  expect(outline).toBe("solid rgb(97, 181, 173)");
});
