/**
 * W-B2.4 (CPW2A): the user's Lecturn web client on the user server, in a
 * headless Chromium: paired once with a one-time pairing URL
 * (`issuePairingUrl`, the standard client scopes), then driven as the user
 * would look at it: the Apps sidebar on RocketWright (`/apps/<appId>`
 * opens it there) and an app thread's closed-app banner
 * (`[data-testid="app-closed-banner"]`, Lecturn's `AppClosedThreadBanner`).
 *
 * Temp state only: the browser has a fresh profile, and the pairing is made
 * against the temp `LECTURN_HOME` the harness passes.
 */
import { chromium, type Browser, type Page } from "@playwright/test";
import { issuePairingUrl } from "./capture/scripted.ts";

const UI_TIMEOUT_MS = 30_000;

export interface AppListingView {
  /** The sidebar shows the app's row. */
  appRow: boolean;
  /** The thread's title shows under it. */
  thread: boolean;
  /** The app row's state chip (`Live`, `Closed`, ...). */
  chip: string | null;
}

export interface BannerView {
  shown: boolean;
  text: string;
}

export class LecturnWebClient {
  readonly origin: string;
  private readonly browser: Browser;
  readonly page: Page;

  private constructor(origin: string, browser: Browser, page: Page) {
    this.origin = origin;
    this.browser = browser;
    this.page = page;
  }

  /** Pairs a fresh headless browser with the Lecturn server in `baseDir` at `origin`. */
  static async open(baseDir: string, origin: string, log: (line: string) => void = () => undefined): Promise<LecturnWebClient> {
    const url = await issuePairingUrl(baseDir, origin);
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
      await page.goto(url);
      await page.waitForURL((u) => !u.pathname.startsWith("/pair"), { timeout: 60_000 });
      log(`web client: paired with ${origin}`);
      return new LecturnWebClient(origin, browser, page);
    } catch (e) {
      await browser.close().catch(() => undefined);
      throw e;
    }
  }

  /** Opens the Apps sidebar on `appId` and reads whether `appName`'s row lists `threadTitle`. */
  async appListing(appId: string, appName: string, threadTitle: string): Promise<AppListingView> {
    const p = this.page;
    await p.goto(new URL(`/apps/${encodeURIComponent(appId)}`, this.origin).href);
    // All apps: one `sidebar-app-row` per app. Scoped to one app (`/apps/<id>`
    // selects it): the app's `app-header` (pin8 `AppsSidebar`) instead.
    const row = p
      .locator('[data-testid="sidebar-app-row"], [data-testid="app-header"]', {
        has: p.locator('[data-testid="sidebar-app-name"], [data-testid="app-header-name"]', { hasText: appName }),
      })
      .first();
    const appRow = await row.waitFor({ timeout: UI_TIMEOUT_MS }).then(
      () => true,
      () => false,
    );
    const title = p.getByText(threadTitle, { exact: true }).first();
    let thread = await title.waitFor({ timeout: 10_000 }).then(
      () => true,
      () => false,
    );
    if (!thread && appRow) {
      // A collapsed row lists nothing: expand it, and open folded sections
      // (Settled starts folded; a finished copied thread sits there), as the user would.
      await row.locator('[data-testid="sidebar-app-expand"]').first().click({ timeout: 2_000 }).catch(() => undefined);
      const folded = p.locator('[data-testid="app-section-heading"] button[aria-expanded="false"]');
      for (let i = await folded.count(); i > 0; i--) await folded.first().click({ timeout: 5_000 }).catch(() => undefined);
      thread = await title.waitFor({ timeout: UI_TIMEOUT_MS }).then(
        () => true,
        () => false,
      );
    }
    const chip = appRow ? await row.locator('[data-testid="sidebar-app-state"]').first().textContent({ timeout: 2_000 }).catch(() => null) : null;
    return { appRow, thread, chip: chip?.trim() ?? null };
  }

  /** Opens the thread and waits for the closed-app banner (null text when it never shows). */
  async closedBanner(environmentId: string, threadId: string, timeoutMs = UI_TIMEOUT_MS): Promise<BannerView> {
    const p = this.page;
    await p.goto(new URL(`/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`, this.origin).href);
    const banner = p.locator('[data-testid="app-closed-banner"]').first();
    const shown = await banner.waitFor({ timeout: timeoutMs }).then(
      () => true,
      () => false,
    );
    const text = shown ? ((await banner.textContent().catch(() => "")) ?? "").replace(/\s+/g, " ").trim() : "";
    return { shown, text };
  }

  async screenshot(path: string): Promise<boolean> {
    return this.page.screenshot({ path }).then(
      () => true,
      () => false,
    );
  }

  async close(): Promise<void> {
    await this.browser.close().catch(() => undefined);
  }
}
