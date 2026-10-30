/**
 * `--measure` module for the page-04 e2e (`page04.spec.ts`): drives the
 * Results page in the desktop hidden window through DOM events and returns a
 * JSON report the spec asserts on. Every function passed to `evaluate` runs in
 * the page and must be self-contained (it is stringified).
 */
import type { PageLike } from "./regions.ts";

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** Polls `pred` in the page until it returns true (or throws after `timeoutMs`). */
async function waitFor(page: PageLike, what: string, pred: (arg: null) => boolean, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await page.evaluate(pred, null)) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Everything visible on the page (runs in the page). */
function readPage(): Json {
  const q = (s: string, root: ParentNode = document) => Array.from(root.querySelectorAll<HTMLElement>(s));
  const one = (s: string) => document.querySelector<HTMLElement>(s);
  // Text nodes joined by single spaces (adjacent spans read as separate words).
  const text = (el: Element | null) => {
    if (!el) return "";
    const out: string[] = [];
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) out.push(n.textContent ?? "");
    return out.map((t) => t.trim()).filter(Boolean).join(" ").replace(/\s+/g, " ");
  };
  const rect = (s: string) => {
    const el = one(s);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
  };
  const parseColor = (c: string) => (c.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map(Number);

  // Pixels of the uPlot canvas: count series-coloured pixels and sample event-line columns.
  const canvas = one('[data-testid="plot.canvas"] canvas');
  let pixels: Json = null;
  if (canvas instanceof HTMLCanvasElement) {
    const ctx = canvas.getContext("2d");
    if (ctx) {
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const near = (i: number, rgb: number[]) => Math.abs(img[i]! - rgb[0]!) + Math.abs(img[i + 1]! - rgb[1]!) + Math.abs(img[i + 2]! - rgb[2]!) < 40;
      const teal = [0x61, 0xb5, 0xad];
      const sand = [0xf1, 0xae, 0x6e];
      let nTeal = 0;
      let nSand = 0;
      for (let i = 0; i < img.length; i += 4) {
        if (img[i + 3]! < 128) continue;
        if (near(i, teal)) nTeal++;
        else if (near(i, sand)) nSand++;
      }
      const ratio = canvas.width / canvas.getBoundingClientRect().width;
      const columns = q('[data-testid="plot.event"]').map((e) => {
        const x = Math.round(Number(e.dataset.x) * ratio);
        // A tick sits on the time axis: count only its own band (above the plot bottom, 2 px slack).
        const tick = e.dataset.mark === "tick";
        const y0 = tick ? Math.max(0, Math.floor((Number(e.dataset.lineTop) - 2) * ratio)) : 0;
        const y1 = tick ? Math.min(canvas.height, y0 + Math.ceil(24 * ratio)) : canvas.height;
        let lit = 0;
        for (let y = y0; y < y1; y++) {
          for (const dx of [-1, 0, 1]) {
            const i = (y * canvas.width + x + dx) * 4;
            if (img[i + 3]! > 100 && img[i]! + img[i + 1]! + img[i + 2]! > 200) {
              lit++;
              break;
            }
          }
        }
        return { label: e.dataset.label ?? "", mark: e.dataset.mark ?? "line", lit };
      });
      pixels = { width: canvas.width, height: canvas.height, teal: nTeal, sand: nSand, eventColumns: columns };
    }
  }

  const inset = one('[data-testid="inset.trajectory"]');
  return {
    title: text(one('[data-testid="page.title"]')),
    titleFontPx: one('[data-testid="page.title"]') ? parseFloat(getComputedStyle(one('[data-testid="page.title"]')!).fontSize) : null,
    headerTab: text(one('[data-testid="header.tab"][aria-selected="true"]')),
    toolbar: ["results.run-selected", "results.plot-menu", "results.export-csv"].map((id) => text(one(`[data-testid="${id}"]`))),
    runSelectedBg: one('[data-testid="results.run-selected"]') ? parseColor(getComputedStyle(one('[data-testid="results.run-selected"]')!).backgroundColor) : null,
    columns: q('[data-testid="runs.table-header"] th').map(text),
    rows: q('[data-testid="runs.table-row"]').map((r) => ({
      sim: r.dataset.sim ?? "",
      status: r.dataset.status ?? "",
      series: r.dataset.series ?? null,
      selected: r.getAttribute("aria-selected") === "true",
      checked: (r.querySelector('input[type="checkbox"]') as HTMLInputElement | null)?.checked ?? false,
      cells: q("td", r).map(text),
      bg: parseColor(getComputedStyle(r).backgroundColor),
    })),
    rail: q('[data-testid="rail.nav-row"]').map((r) => ({
      sim: r.dataset.sim ?? "",
      text: text(r),
      selected: r.getAttribute("aria-selected") === "true",
      eye: r.querySelector('[data-testid="rail.eye"] svg')?.getAttribute("data-icon") ?? null,
      statusIcon: r.querySelector(".rw-status-glyph")?.getAttribute("data-icon") ?? null,
    })),
    railTitle: text(one('[data-testid="rail.nav-title"]')),
    banner: text(one('[data-testid="results.outdated-banner"]')),
    tabs: q('[data-testid="plot.tab"]').map((t) => ({ text: text(t), selected: t.getAttribute("aria-selected") === "true" })),
    axes: q('[data-testid="plot.axis"]').map(text),
    legend: q('[data-testid="plot.series"]').map((s) => ({ sim: s.dataset.sim ?? "", text: text(s), color: s.dataset.color ?? "", points: Number(s.dataset.points) })),
    eventsKey: one('[data-testid="plot.events-key"]') ? { text: text(one('[data-testid="plot.events-key"]')), color: one('[data-testid="plot.events-key"]')!.dataset.color ?? "" } : null,
    events: q('[data-testid="plot.event"]').map((e) => ({
      label: e.dataset.label ?? "",
      sim: e.dataset.sim ?? null,
      color: e.dataset.color ?? null,
      t: Number(e.dataset.t),
      x: e.dataset.x === undefined ? null : Number(e.dataset.x),
      row: e.dataset.row === undefined ? null : Number(e.dataset.row),
      labelled: e.dataset.labelled === "true",
      labelTop: e.dataset.labelTop === undefined ? null : Number(e.dataset.labelTop),
      plotTop: e.dataset.plotTop === undefined ? null : Number(e.dataset.plotTop),
    })),
    // Label boxes as drawn (canvas font, 4 px gap, 16 px rows): placement is pure, so this mirrors drawEventLines.
    eventLabels: (() => {
      const c = document.createElement("canvas").getContext("2d");
      const plotCanvas = one('[data-testid="plot.canvas"] canvas');
      if (!c || !plotCanvas) return [];
      c.font = `${12}px ${getComputedStyle(plotCanvas).fontFamily || "sans-serif"}`;
      return q('[data-testid="plot.event"]')
        .filter((e) => e.dataset.labelled === "true" && e.dataset.x !== undefined)
        .map((e) => {
          const w = c.measureText(e.dataset.label ?? "").width;
          const x = Number(e.dataset.x);
          // Left-to-right span of the label box (gap included), left of the line when flipped.
          const span = e.dataset.flip === "true" ? [x - 4 - w, x] : [x, x + 4 + w];
          return { label: e.dataset.label ?? "", sim: e.dataset.sim ?? null, row: Number(e.dataset.row), a: span[0]!, b: span[1]! };
        });
    })(),
    pixels,
    inset: inset
      ? {
          ready: inset.dataset.ready ?? null,
          error: inset.dataset.error ?? null,
          backend: inset.dataset.backend ?? null,
          paths: Number(inset.dataset.paths),
          points: Number(inset.dataset.points),
          ground: Number(inset.dataset.ground),
          pad: Number(inset.dataset.pad),
          gizmo: q('[data-testid="inset.gizmo"] [data-axis]').map((g) => g.dataset.axis ?? ""),
          legend: q('[data-testid="inset.legend"] li').map(text),
          title: text(one(".rw-results__inset-title")),
        }
      : null,
    details: q('[data-testid="details.field"]').map(text),
    detailRects: q('[data-testid="details.field"]').map((f) => {
      const r = f.getBoundingClientRect();
      return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
    }),
    // Footer texts that would be clipped (ellipsis): scroll width past the box.
    detailsClipped: q('[data-testid="details.field"] .rw-details__text')
      .filter((t) => t.scrollWidth > t.clientWidth + 0.5)
      .map(text),
    snapshots: q('[data-testid="history.snapshot"]').map((s) => ({ sim: s.dataset.sim ?? "", series: s.dataset.series ?? null, text: text(s) })),
    regions: Object.fromEntries(["run-table", "plot", "trajectory-inset", "run-details", "run-snapshots", "history-strip", "workspace", "left-rail"].map((r) => [r, rect(`[data-rw-region="${r}"]`)])),
  };
}

const pageReady = () => {
  const rows = document.querySelectorAll('[data-testid="runs.table-row"]').length;
  const series = document.querySelectorAll('[data-testid="plot.series"]').length;
  const events = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="plot.event"]'));
  const inset = document.querySelector<HTMLElement>('[data-testid="inset.trajectory"]')?.dataset.ready;
  // The table lists the three sims with runs (Recovery test, never run, is in the rail only); the selected run's three events are drawn.
  return rows >= 3 && series === 2 && events.length === 3 && events.every((e) => e.dataset.x !== undefined) && (inset === "true" || inset === "error");
};

function click(selector: string): boolean {
  const el = document.querySelector<HTMLElement>(selector);
  if (!el) return false;
  el.click();
  return true;
}

export default async function drive(page: PageLike): Promise<Json> {
  await waitFor(page, "results page with two plotted runs", pageReady);
  // Let uPlot and the inset settle one more frame.
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))), null);
  const initial = await page.evaluate(readPage, null);

  // The agent's plot_render (CPW2A): the window's broker host draws both runs off-screen; count their colours in the PNG.
  const plotRender = await page.evaluate(async () => {
    type Answer = { ok: boolean; result?: { png_base64: string; width: number; height: number; runs?: { sim: string }[] }; error?: { code: string; message: string } };
    const call = (window as unknown as { __rwBroker?: (op: string, args: unknown) => Promise<Answer> }).__rwBroker;
    if (call === undefined) return { error: "no window.__rwBroker" };
    const page0 = document.querySelector('[data-testid="header.tab"][aria-selected="true"]')?.textContent ?? "";
    const r = await call("plot_render", { plot: "altitude", runs: ["baseline", "higher_altitude"], width: 1000, height: 600 });
    const unknown = await call("plot_render", { plot: "altitude", runs: ["deadbeef0000"] });
    const page1 = document.querySelector('[data-testid="header.tab"][aria-selected="true"]')?.textContent ?? "";
    if (!r.ok || r.result === undefined) return { error: JSON.stringify(r.error ?? null) };
    const img = new Image();
    img.src = `data:image/png;base64,${r.result.png_base64}`;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    const px = ctx.getImageData(0, 0, c.width, c.height).data;
    const near = (i: number, rgb: number[]) => Math.abs(px[i]! - rgb[0]!) + Math.abs(px[i + 1]! - rgb[1]!) + Math.abs(px[i + 2]! - rgb[2]!) < 40;
    let teal = 0;
    let sand = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (near(i, [0x61, 0xb5, 0xad])) teal++;
      else if (near(i, [0xf1, 0xae, 0x6e])) sand++;
    }
    return {
      width: img.naturalWidth,
      height: img.naturalHeight,
      reported: [r.result.width, r.result.height],
      runs: (r.result.runs ?? []).map((x) => x.sim),
      teal,
      sand,
      unknown: unknown.error ?? null,
      pageBefore: page0,
      pageAfter: page1,
    };
  }, null);

  // Plot tabs.
  await page.evaluate(click, '[data-testid="plot.tab"][data-tab="velocity"]');
  await waitFor(page, "velocity tab", () => document.querySelector('[data-testid="plot.axis"][data-axis="y"]')?.textContent === "Velocity (m/s)");
  const velocity = await page.evaluate(readPage, null);
  await page.evaluate(click, '[data-testid="plot.tab"][data-tab="altitude"]');

  // Export CSV: capture the blob handed to the download link.
  const csv = await page.evaluate(async () => {
    const w = window as unknown as { __rwBlobs?: Blob[] };
    w.__rwBlobs = [];
    const orig = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (b: Blob | MediaSource) => {
      if (b instanceof Blob) w.__rwBlobs!.push(b);
      return orig(b);
    };
    let fileName = "";
    const origClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      fileName = this.download;
    };
    document.querySelector<HTMLElement>('[data-testid="results.export-csv"]')!.click();
    HTMLAnchorElement.prototype.click = origClick;
    const blob = w.__rwBlobs[0];
    const text = blob ? await blob.text() : "";
    const lines = text.trim().split("\n");
    const runs: Record<string, number> = {};
    for (const l of lines.slice(1)) runs[l.split(",")[0]!] = (runs[l.split(",")[0]!] ?? 0) + 1;
    return { fileName, header: lines[0] ?? "", rows: lines.length - 1, runs };
  }, null);

  // Sorting by apogee: ascending, then descending.
  const order = () => Array.from(document.querySelectorAll<HTMLElement>('[data-testid="runs.table-row"]')).map((r) => r.dataset.sim ?? "");
  await page.evaluate(click, '[data-testid="runs.sort"][data-key="apogee"]');
  const sortAsc = await page.evaluate(order, null);
  await page.evaluate(click, '[data-testid="runs.sort"][data-key="apogee"]');
  const sortDesc = await page.evaluate(order, null);
  await page.evaluate(click, '[data-testid="runs.sort"][data-key="apogee"]');
  const sortOff = await page.evaluate(order, null);

  // Overlay: untick Higher altitude, then tick it again.
  await page.evaluate(click, '[data-testid="runs.table-row"][data-sim="higher_altitude"] [data-testid="runs.overlay"]');
  await waitFor(page, "one plotted run", () => document.querySelectorAll('[data-testid="plot.series"]').length === 1);
  const single = await page.evaluate(readPage, null);
  await page.evaluate(click, '[data-testid="runs.table-row"][data-sim="higher_altitude"] [data-testid="runs.overlay"]');
  await waitFor(page, "two plotted runs again", () => document.querySelectorAll('[data-testid="plot.series"]').length === 2);

  // Rail eye: hide Fin revision (the banner goes with it), then show it again.
  await page.evaluate(click, '[data-testid="rail.nav-row"][data-sim="fin_revision"] [data-testid="rail.eye"]');
  const hidden = await page.evaluate(readPage, null);
  await page.evaluate(click, '[data-testid="rail.nav-row"][data-sim="fin_revision"] [data-testid="rail.eye"]');

  // Assumptions popover.
  await page.evaluate(click, '[data-testid="details.field"][data-field="assumptions"]');
  const assumptions = await page.evaluate(() => Array.from(document.querySelectorAll('[data-testid="details.assumptions"] li')).map((l) => l.textContent ?? ""), null);
  await page.evaluate(click, '[data-testid="details.field"][data-field="assumptions"]');

  // Selecting the never-run sim in the rail; Run selected starts it through the RPC, and it joins the table.
  await page.evaluate(click, '[data-testid="rail.nav-row"][data-sim="recovery_test"]');
  const railSelected = await page.evaluate(
    () => Array.from(document.querySelectorAll<HTMLElement>('[data-testid="rail.nav-row"][aria-selected="true"]')).map((r) => r.dataset.sim ?? ""),
    null,
  );
  await page.evaluate(click, '[data-testid="results.run-selected"]');
  await waitFor(page, "recovery test complete", () => document.querySelector<HTMLElement>('[data-testid="runs.table-row"][data-sim="recovery_test"]')?.dataset.status === "complete");
  const afterRun = await page.evaluate(readPage, null);

  // Open design from the banner navigates to Design; the Results tab comes back.
  await page.evaluate(click, '[data-testid="results.open-design"]');
  const afterOpenDesign = await page.evaluate(() => document.querySelector('[data-testid="header.tab"][aria-selected="true"]')?.textContent ?? "", null);
  await page.evaluate(() => {
    const tab = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="header.tab"]')).find((t) => t.textContent === "Results");
    tab?.click();
  }, null);
  await waitFor(page, "results page again", pageReady);
  // Leave the capture on the concept state's selection (Baseline). Selecting a run opens its agent thread, made on
  // the first visit: the guest creates it, then navigates to it. Return only once the pane shows it, or that
  // navigation lands during the capture and the pane's composite is dropped as stale (exit 1 on a slow CI VM).
  await page.evaluate(click, '[data-testid="rail.nav-row"][data-sim="baseline"]');
  await waitFor(
    page,
    "the agent pane on Baseline's thread",
    () => document.querySelector('[data-testid="agent.embed"]') === null || document.querySelector('[data-testid="rail.thread"][data-artifact="rw:sim/baseline"][aria-selected="true"]') !== null,
  );

  return { initial, plotRender, velocity, csv, sortAsc, sortDesc, sortOff, single, hidden, assumptions, railSelected, afterRun, afterOpenDesign };
}
