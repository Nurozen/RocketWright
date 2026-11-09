/**
 * D27's source scan: the drive may use only the calls a person's hands map to.
 * An allowlist, because a denylist leaves `page.evaluate`, `force` and
 * `dispatchEvent` style escapes open: any method not named here is rejected.
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const E2E = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCANNED = ["rebuild-case1.spec.ts", "case1-script.ts", "case1-stages.ts"];

/** Playwright calls a person's actions map to. */
const PLAYWRIGHT = ["getByRole", "getByLabel", "getByText", "first", "nth", "innerText", "allInnerTexts", "click", "dblclick", "fill", "press", "selectOption", "check", "hover", "type", "insertText", "down", "up", "expect"];
const WEB_FIRST = ["toBeVisible", "toBeHidden", "toBeEnabled", "toBeDisabled", "toBeChecked", "toBeEditable", "toBeFocused", "toContainText", "toHaveText", "toHaveValue", "toHaveAccessibleName", "toHaveAccessibleDescription", "toHaveCount"];
/** JS built-ins the scanned files use. Must never name a Playwright method (checked below). */
const JS_BUILT_INS = ["entries", "values", "keys", "map", "push", "join", "split", "replace", "trim", "startsWith", "endsWith", "slice", "includes", "has", "get", "set", "add", "exec", "test", "findIndex", "sort", "at", "now", "stringify"];
/** The spec's scaffolding. `describe` is also `Locator.describe`, which only names a locator in logs. */
const TEST_SCAFFOLD = ["describe", "setTimeout", "beforeEach", "afterEach", "step"];
/** `Lifecycle`, which the spec implements outside this scan. Must never name a Playwright method (checked below). */
const OWN = ["chooseFolder", "quit", "relaunch", "finish"];
const ALLOWED = new Set([...PLAYWRIGHT, ...WEB_FIRST, ...JS_BUILT_INS, ...TEST_SCAFFOLD, ...OWN]);

const BANNED_NAME = /^(getByTestId|locator|dispatchEvent|evaluate|evaluateHandle|goto|RpcClient|force|mouse|touchscreen)$/;
const BANNED_TEXT = /data-testid|data-field/;
const BANNED_IMPORT = /(^|\/)apps\/web(\/|$)|packages\/contracts|^@rw\//;
const FS_READS = new Set(["readFileSync", "readdirSync", "existsSync", "statSync", "lstatSync"]);
const BANNED_MODULE = /^(node:)?(child_process|net|http|https|worker_threads|vm)$/;
const FS_MODULE = /^(node:)?fs(\/promises)?$/;

export function scanDrive(text: string, file = "x.ts"): string[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2024, true, ts.ScriptKind.TS);
  const out: string[] = [];
  const reject = (node: ts.Node, why: string) => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
    out.push(`${file}:${line + 1}: ${why}`);
  };
  const checkImport = (node: ts.ImportDeclaration) => {
    const spec = (node.moduleSpecifier as ts.StringLiteral).text;
    if (BANNED_IMPORT.test(spec)) reject(node, `imports product code from ${spec}: labels taken from it would not catch a mislabel`);
    if (BANNED_MODULE.test(spec)) reject(node, `imports ${spec}`);
    if (!FS_MODULE.test(spec)) return;
    if (spec.endsWith("/promises")) return reject(node, `imports ${spec}`);
    const clause = node.importClause;
    if (clause?.name !== undefined || (clause?.namedBindings !== undefined && !ts.isNamedImports(clause.namedBindings))) return reject(node, `imports all of ${spec}: only named reads are allowed`);
    if (clause?.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings)) {
      for (const el of clause.namedBindings.elements) {
        const name = (el.propertyName ?? el.name).text;
        if (!FS_READS.has(name)) reject(el, `node:fs write: ${name}`);
      }
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) checkImport(node);
    if (ts.isIdentifier(node) && (BANNED_NAME.test(node.text) || node.text.includes("Hooks"))) reject(node, `banned name ${node.text}`);
    if ((ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) && (BANNED_TEXT.test(node.text) || BANNED_NAME.test(node.text))) reject(node, `banned text ${node.text}`);
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isPropertyAccessExpression(callee)) {
        if (!ALLOWED.has(callee.name.text)) reject(callee.name, `.${callee.name.text}() is not on the allowlist`);
      } else if (ts.isElementAccessExpression(callee)) {
        reject(callee, "a computed call could reach any method");
      } else if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === "require")) {
        reject(callee, "dynamic imports hide what the file uses");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** `E/case1-compare.ts`: it must not hold the arguments that would fly. */
export function scanCompare(text: string, file = "case1-compare.ts"): string[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2024, true, ts.ScriptKind.TS);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) && (/^\s*(sim|simulate)(\s|$)/.test(node.text) || node.text.includes("--force"))) {
      out.push(`${file}: banned argument ${JSON.stringify(node.text)}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

const banned: readonly (readonly [string, string])[] = [
  ["getByTestId", 'await page.getByTestId("x").click();'],
  ["locator(", 'await page.locator("[x]").click();'],
  ["data-testid", 'await page.getByLabel("a[data-testid=b]").click();'],
  ["data-field", 'await page.getByText("[data-field=x]").click();'],
  ["force", "await page.getByLabel('a').click({ force: true });"],
  ["dispatchEvent", 'await page.getByLabel("a").dispatchEvent("click");'],
  ["page.evaluate", "await page.evaluate(() => 1);"],
  ["app.evaluate", "await app.evaluate(() => 1);"],
  ["evaluate via a computed call", 'await page["evaluate"](() => 1);'],
  ["goto", 'await page.goto("about:blank");'],
  ["Hooks", 'import { rwHooks } from "./hooks.ts"; rwHooks();'],
  ["RpcClient", 'import { RpcClient } from "./rpc.ts"; new RpcClient();'],
  ["test.call", "await test.call(null);"],
  ["node:fs writes", 'import { writeFileSync } from "node:fs"; writeFileSync("a", "b");'],
  ["node:fs namespace", 'import * as fs from "node:fs"; fs.readFileSync("a");'],
  ["node:fs/promises", 'import { readFile } from "node:fs/promises"; await readFile("a");'],
  ["child_process", 'import { execFileSync } from "node:child_process"; execFileSync("x");'],
  ["imports from W/", 'import { LABELS } from "../apps/web/src/pages/components/fields.ts"; LABELS;'],
  ["imports from C/", 'import type { X } from "../packages/contracts/src/rpc.ts"; let x: X;'],
  ["imports @rw", 'import { SCHEMA_META } from "@rw/contracts"; SCHEMA_META;'],
  ["Locator.filter", 'await page.getByRole("row").filter({ hasText: "x" }).click();'],
  ["mouse", "await page.mouse.click(1, 2);"],
  ["an unknown method", "await page.waitForFunction(() => true);"],
  ["inputValue", 'await page.getByLabel("a").inputValue();'],
  ["non web-first matcher", "expect(value).toBe(1);"],
  ["dynamic import", 'const m = await import("./x.ts"); m;'],
];

describe("the drive scan", () => {
  it.each(banned)("rejects %s", (_name, snippet) => {
    expect(scanDrive(snippet)).not.toEqual([]);
  });

  it("accepts what a person's hands do", () => {
    const ok = `
      import { readFileSync } from "node:fs";
      await page.getByRole("tab", { name: "Design", exact: true }).click();
      await scope.getByLabel("Length", { exact: true }).first().fill("10");
      await page.getByText("Saved").nth(1).hover();
      await page.keyboard.press("Enter");
      await input.selectOption({ label: "Ogive" });
      await input.check();
      await expect(input).toHaveAccessibleDescription("mm");
      await expect(input).not.toBeHidden();
      const texts = await row.getByRole("cell").allInnerTexts();
      readFileSync("a").toString;
    `;
    expect(scanDrive(ok)).toEqual([]);
  });

  it("the drive's own files pass", () => {
    const present = SCANNED.filter((f) => existsSync(join(E2E, f)));
    expect(present).toContain("case1-script.ts");
    expect(present).toContain("case1-stages.ts");
    for (const f of present) expect(scanDrive(readFileSync(join(E2E, f), "utf8"), f), f).toEqual([]);
  });

  it("keeps the JS built-ins free of Playwright's method names", () => {
    const require = createRequire(join(E2E, "playwright.config.ts"));
    const types = join(dirname(require.resolve("playwright-core/package.json")), "types/types.d.ts");
    const sf = ts.createSourceFile("types.d.ts", readFileSync(types, "utf8"), ts.ScriptTarget.ES2024, true);
    const methods = new Set<string>();
    const visit = (node: ts.Node): void => {
      if (ts.isInterfaceDeclaration(node) && ["Page", "Frame", "Locator", "ElectronApplication", "BrowserContext", "FrameLocator", "Keyboard", "Mouse"].includes(node.name.text)) {
        for (const m of node.members) if (m.name !== undefined && ts.isIdentifier(m.name)) methods.add(m.name.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    expect(methods.has("evaluate")).toBe(true);
    expect(JS_BUILT_INS.filter((m) => methods.has(m))).toEqual([]);
    expect(OWN.filter((m) => methods.has(m))).toEqual([]);
  });
});

describe("the compare scan", () => {
  it.each([
    ['["sim", "--json"]'],
    ['["simulate"]'],
    ['["run", "--force"]'],
    ["`sim ${name}`"],
    ["`simulate`"],
    ['"--force=1"'],
  ])("rejects %s", (text) => {
    expect(scanCompare(`const a = ${text};`)).not.toEqual([]);
  });

  it("allows run ids, sim keys and manifest fields", () => {
    expect(scanCompare('const k = "sim.launch.rail_length"; const d = "sims"; const v = manifest.sim; f(`${manifest.sim}/${id}`);')).toEqual([]);
  });

  it("case1-compare.ts holds no flying argument", () => {
    expect(scanCompare(readFileSync(join(E2E, "case1-compare.ts"), "utf8"))).toEqual([]);
  });
});
