/**
 * `make package`: the RocketWright desktop app as electron-builder artifacts
 * in dist/desktop/, for the host platform and arch (macOS: dmg + zip;
 * Linux: AppImage). docs/dev/releasing.md has the release flow.
 *
 *   node scripts/desktop/package.ts [--targets dmg,zip|AppImage|dir] [--version <semver>]
 *                                   [--signed] [--out <dir>]
 *
 * Inputs, built by the make target first: the release `rocketwright` without
 * `doubles` (target/release), app/apps/web/dist (rw-wasm inside), the vendored
 * Lecturn kit (vendor/lecturn), and app/ installed (Electron, electron-builder,
 * rolldown).
 *
 * The stage (dist/desktop/stage, electron-builder's app dir, packed into
 * app.asar) keeps the repo's relative layout, so the desktop and server code
 * find their files as in a checkout (app/apps/desktop/src/packaged.ts):
 *
 *   app/apps/desktop/src/main.mjs      Electron main and its imports (rolldown bundle)
 *   app/apps/desktop/src/preload.ts    type-stripped at runtime (backend.ts buildPreload)
 *   app/apps/server/src/rpc/cli.mjs    the app server (rolldown bundle)
 *   app/apps/web/dist/                 the web bundle
 *   app/packages/ui/generated/         the Lecturn embed theme
 *   app/apps/desktop/assets/, crates/rw-cli/src/mcp/cards/   the app icon, the MCP cards
 *   node_modules/                      a clean hoisted install of the vendored lecturn and
 *                                      @lecturn/embed (the kit's pnpm settings and patches)
 *
 * Beside the archive (Contents/Resources on macOS): bin/rocketwright,
 * fixtures/research-vehicle (the sample a window opens without --project),
 * NOTICE.md. Natives (*.node, *.dylib, *.so*, node-pty's spawn-helper) are
 * unpacked into app.asar.unpacked, as vendor/lecturn/lecturn-pack.json asks.
 *
 * --signed: sign with the Developer ID identity electron-builder finds
 * (CSC_LINK/CSC_KEY_PASSWORD or CSC_KEYCHAIN) and notarize with
 * APPLE_API_KEY/APPLE_API_KEY_ID/APPLE_API_ISSUER (hardened runtime).
 * Without it the app is ad-hoc signed and not notarized: macOS asks users
 * to approve it on first open.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { PACKAGED_MAIN, PACKAGED_SERVER_CLI } from "../../app/apps/desktop/src/packaged.ts";

// ---- @cursor/sdk -------------------------------------------------------------------------
// THE SWITCH. `@cursor/sdk` is proprietary and grants no redistribution
// right, so the packaged app leaves `@cursor/sdk` and `@cursor/sdk-*` out of
// the bundled Lecturn server's node_modules (default: on). Lecturn runs
// without it from PIN 847fc19f3f on and reports Cursor as not installed.
// RW_PACKAGE_CURSOR_SDK=1 keeps the SDK for local testing only: never publish
// such a build.
const EXCLUDE_CURSOR_SDK = process.env["RW_PACKAGE_CURSOR_SDK"] !== "1";

const ROOT = resolve(import.meta.dirname, "../..");
const APP = join(ROOT, "app");
const DESKTOP = join(APP, "apps/desktop");
const VENDOR = join(ROOT, "vendor/lecturn");
const PRODUCT = "RocketWright";
const APP_ID = "dev.rocketwright.app";

function die(msg: string): never {
  process.stderr.write(`make package: ${msg}\n`);
  process.exit(1);
}

function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): void {
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd: opts.cwd ?? ROOT, env: opts.env ?? process.env });
  if (r.status !== 0) die(`${cmd} ${args.join(" ")} failed (${r.signal ?? r.status})`);
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

const { values } = parseArgs({
  options: {
    targets: { type: "string" },
    version: { type: "string" },
    signed: { type: "boolean", default: false },
    out: { type: "string" },
  },
});

const platform = process.platform === "darwin" ? "mac" : process.platform === "linux" ? "linux" : die(`unsupported platform ${process.platform}`);
const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : die(`unsupported arch ${process.arch}`);
const targets = (values.targets ?? (platform === "mac" ? "dmg,zip" : "AppImage")).split(",").filter((t) => t !== "");
const desktopPkg = readJson<{ version: string; devDependencies: Record<string, string> }>(join(DESKTOP, "package.json"));
const version = values.version ?? desktopPkg.version;
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) die(`--version ${version}: not a semver version`);
const signed = values.signed === true;
const out = resolve(values.out ?? join(ROOT, "dist/desktop"));
const stage = join(out, "stage");
const pnpmVersion = readJson<{ packageManager: string }>(join(APP, "package.json")).packageManager;

// ---- inputs ------------------------------------------------------------------------------
const target = resolve(ROOT, process.env["CARGO_TARGET_DIR"] ?? "target");
const rwBin = process.env["RW_PACKAGE_BIN"] ?? join(target, "release/rocketwright");
const webDist = join(APP, "apps/web/dist");
const kit = readJson<{ packages: Record<string, { name: string; tarball: string }>; pnpm: { allowBuilds: Record<string, boolean>; patchedDependencies: Record<string, string> } }>(
  join(VENDOR, "lecturn-pack.json"),
);
const missing: string[] = [];
if (!existsSync(rwBin)) missing.push(`${rwBin} (cargo build --release -p rw-cli --bin rocketwright)`);
if (!existsSync(join(webDist, "index.html"))) missing.push(`${webDist}/index.html (pnpm --dir app --filter @rw/web build)`);
for (const p of Object.values(kit.packages)) if (!existsSync(join(VENDOR, p.tarball))) missing.push(`${join(VENDOR, p.tarball)} (make vendor-lecturn)`);
for (const p of Object.values(kit.pnpm.patchedDependencies)) if (!existsSync(join(VENDOR, p))) missing.push(`${join(VENDOR, p)} (make vendor-lecturn)`);
const builderBin = join(DESKTOP, "node_modules/.bin/electron-builder");
if (!existsSync(builderBin)) missing.push(`${builderBin} (pnpm --dir app install)`);
if (missing.length > 0) die(`missing input:\n  ${missing.join("\n  ")}`);
const rwVersion = spawnSync(rwBin, ["--version"], { encoding: "utf8" }).stdout.trim();
if (rwVersion === "" || rwVersion.includes("doubles")) die(`${rwBin} is '${rwVersion}': ship the plain release build, never doubles`);

// Electron downloads its binary on first use (docs/dev/environment.md).
const electronPkgDir = join(DESKTOP, "node_modules/electron");
const electronDist = join(electronPkgDir, "dist");
if (!existsSync(electronDist)) run(process.execPath, [join(electronPkgDir, "install.js")], { env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } });
const electronVersion = readJson<{ version: string }>(join(electronPkgDir, "package.json")).version;

console.log(`make package: ${PRODUCT} ${version} (${platform}-${arch}: ${targets.join(", ")}; ${signed ? "signed" : "unsigned"}; ${rwVersion}; Electron ${electronVersion})`);
rmSync(out, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

// ---- Lecturn server install ----------------------------------------------------------------
// A clean hoisted install of the two tarballs with the kit's settings, as
// Lecturn's smoke-pack-install proves the kit (scripts/vendor-lecturn.sh).
const patches: Record<string, string> = {};
for (const [selector, rel] of Object.entries(kit.pnpm.patchedDependencies)) {
  mkdirSync(dirname(join(stage, rel)), { recursive: true });
  cpSync(join(VENDOR, rel), join(stage, rel));
  patches[selector] = rel;
}
const dependencies = Object.fromEntries(Object.values(kit.packages).map((p) => [p.name, `file:${join(VENDOR, p.tarball)}`]));
writeFileSync(
  join(stage, "package.json"),
  `${JSON.stringify(
    {
      name: "rocketwright",
      productName: PRODUCT,
      version,
      description: "Agent-driven rocket design and simulation",
      homepage: "https://github.com/Nurozen/RocketWright",
      author: { name: "Cloud Gatherer Labs LLC" },
      license: "AGPL-3.0-or-later",
      private: true,
      type: "module",
      main: PACKAGED_MAIN,
      packageManager: pnpmVersion,
      dependencies,
    },
    null,
    2,
  )}\n`,
);
// JSON is valid YAML.
writeFileSync(join(stage, "pnpm-workspace.yaml"), `${JSON.stringify({ nodeLinker: "hoisted", allowBuilds: kit.pnpm.allowBuilds, patchedDependencies: patches })}\n`);
// CI makes pnpm default to a frozen lockfile; the stage has none yet.
run("pnpm", ["install", "--prod", "--no-frozen-lockfile"], { cwd: stage });

/** Every `@cursor/sdk` and `@cursor/sdk-*` package directory under `dir`'s node_modules trees. */
function cursorSdkDirs(dir: string): string[] {
  const found: string[] = [];
  const walk = (nm: string): void => {
    if (!existsSync(nm)) return;
    for (const name of readdirSync(nm)) {
      const p = join(nm, name);
      if (name === "@cursor") {
        for (const sub of readdirSync(p)) if (sub === "sdk" || sub.startsWith("sdk-")) found.push(join(p, sub));
      } else if (name.startsWith("@")) {
        for (const sub of readdirSync(p)) walk(join(p, sub, "node_modules"));
      } else if (!name.startsWith(".")) walk(join(p, "node_modules"));
    }
  };
  walk(join(dir, "node_modules"));
  return found;
}

const resources = join(stage, "resources");
const extraResources: Array<{ from: string; to: string; filter?: string[] }> = [{ from: "resources", to: ".", filter: ["**/*"] }];
if (EXCLUDE_CURSOR_SDK) {
  const dirs = cursorSdkDirs(stage);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  console.log(`make package: left out @cursor/sdk (${dirs.map((d) => relative(stage, d)).join(", ") || "not installed"}); see EXCLUDE_CURSOR_SDK`);
} else {
  // The kit's asar layout: the Cursor helpers beside the archive as real
  // files (staged outside resources/: extraResources skips node_modules dirs).
  for (const d of cursorSdkDirs(stage).filter((p) => /[\\/]sdk-[^\\/]+$/.test(p))) {
    cpSync(realpathSync(d), join(stage, "cursor-sdk", d.split(/[\\/]/).pop() ?? ""), { recursive: true, dereference: true });
  }
  extraResources.push({ from: "cursor-sdk", to: "node_modules/@cursor", filter: ["**/*"] });
  console.log("make package: WARNING: RW_PACKAGE_CURSOR_SDK=1 bundles the proprietary @cursor/sdk; local testing only, never publish");
}

// ---- app code ------------------------------------------------------------------------------
const rolldownEntry = createRequire(join(DESKTOP, "package.json")).resolve("rolldown");
const { rolldown } = (await import(pathToFileURL(rolldownEntry).href)) as {
  rolldown: (o: Record<string, unknown>) => Promise<{ write(o: Record<string, unknown>): Promise<unknown>; close(): Promise<void> }>;
};
/** Resolved at runtime from the stage's node_modules (and Electron itself), never bundled. */
const isExternal = (id: string): boolean => id === "electron" || /^(lecturn|@lecturn\/embed)(\/|$)/.test(id) || id.startsWith("node:");

async function bundle(entry: string, outFile: string): Promise<void> {
  const b = await rolldown({ input: join(APP, entry), platform: "node", external: isExternal, cwd: APP, logLevel: "warn" });
  try {
    await b.write({ file: join(stage, outFile), format: "esm", codeSplitting: false, sourcemap: false });
  } finally {
    await b.close();
  }
}
await bundle("apps/desktop/src/main.ts", PACKAGED_MAIN);
await bundle("apps/server/src/rpc/cli.ts", PACKAGED_SERVER_CLI);

const copies: Array<[string, string]> = [
  ["app/apps/desktop/src/preload.ts", "app/apps/desktop/src/preload.ts"],
  ["app/apps/web/dist", "app/apps/web/dist"],
  ["app/packages/ui/generated/lecturn-theme.json", "app/packages/ui/generated/lecturn-theme.json"],
  ["app/packages/ui/generated/lecturn-theme-host.json", "app/packages/ui/generated/lecturn-theme-host.json"],
  ["app/apps/desktop/assets", "app/apps/desktop/assets"],
  ["crates/rw-cli/src/mcp/cards", "crates/rw-cli/src/mcp/cards"],
];
for (const [from, to] of copies) cpSync(join(ROOT, from), join(stage, to), { recursive: true });
mkdirSync(join(resources, "bin"), { recursive: true });
cpSync(rwBin, join(resources, "bin/rocketwright"));
chmodSync(join(resources, "bin/rocketwright"), 0o755);
cpSync(join(ROOT, "fixtures/research-vehicle"), join(resources, "fixtures/research-vehicle"), {
  recursive: true,
  filter: (src) => !src.split(/[\\/]/).includes(".rw"),
});
for (const f of ["LICENSE", "NOTICE.md"]) if (existsSync(join(ROOT, f))) cpSync(join(ROOT, f), join(resources, f));

// ---- electron-builder ----------------------------------------------------------------------
const otherArch = arch === "arm64" ? "x64" : "arm64";
// electron-builder makes the .icns and the Linux icon set from this 1024 px PNG.
const icon = join(ROOT, "app/apps/desktop/assets/app-icon-1024.png");
const config: Record<string, unknown> = {
  appId: APP_ID,
  productName: PRODUCT,
  copyright: "Copyright (C) 2026 Cloud Gatherer Labs LLC. AGPL-3.0-or-later.",
  artifactName: `${PRODUCT}-\${version}-\${os}-\${arch}.\${ext}`,
  directories: { output: out, buildResources: join(stage, "build-resources") },
  electronDist,
  electronVersion,
  electronLanguages: ["en-US"],
  // Natives come prebuilt (N-API) or built by the stage install for this host.
  npmRebuild: false,
  nodeGypRebuild: false,
  asar: true,
  asarUnpack: ["**/*.node", "**/*.dylib", "**/*.so", "**/*.so.*", "**/spawn-helper"],
  files: [
    "**/*",
    "!resources",
    "!resources/**",
    "!cursor-sdk",
    "!cursor-sdk/**",
    "!patches",
    "!patches/**",
    "!build-resources",
    "!pnpm-lock.yaml",
    "!pnpm-workspace.yaml",
    "!**/*.map",
    "!**/*.d.ts",
    "!**/*.d.mts",
    "!**/*.d.cts",
    // Terminal helpers for other platforms (Lecturn's own exclusions).
    "!**/node_modules/node-pty/prebuilds/win32-*/**",
    "!**/node_modules/node-pty/third_party/conpty/**",
    `!**/node_modules/node-pty/prebuilds/darwin-${platform === "mac" ? otherArch : "*"}/**`,
  ],
  extraResources,
  protocols: [{ name: PRODUCT, schemes: ["rocketwright"] }],
  publish: null,
};
if (platform === "mac") {
  config["mac"] = {
    target: targets.map((t) => ({ target: t, arch: [arch] })),
    category: "public.app-category.education",
    icon,
    // Unsigned: an ad-hoc signature keeps the bundle seal valid, so a
    // quarantined copy asks for approval instead of reporting it damaged.
    identity: signed ? undefined : "-",
    hardenedRuntime: signed,
    notarize: signed ? undefined : false,
    extendInfo: { LSApplicationCategoryType: "public.app-category.education" },
  };
  config["dmg"] = { title: `${PRODUCT} \${version}` };
} else {
  config["linux"] = {
    target: targets.map((t) => ({ target: t, arch: [arch] })),
    executableName: "rocketwright",
    icon,
    category: "Science",
    synopsis: "Agent-driven rocket design and simulation",
  };
  // The static AppImage runtime also starts where only FUSE 3 is installed.
  config["toolsets"] = { appimage: "1.0.3" };
}
writeFileSync(join(stage, "electron-builder.json"), `${JSON.stringify(config, null, 2)}\n`);

const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: undefined };
if (!signed) {
  env["CSC_IDENTITY_AUTO_DISCOVERY"] = "false";
  for (const k of ["CSC_LINK", "CSC_KEY_PASSWORD", "APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER", "APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD"]) delete env[k];
} else if (platform === "mac" && !(env["APPLE_API_KEY"] && env["APPLE_API_KEY_ID"] && env["APPLE_API_ISSUER"])) {
  die("--signed needs APPLE_API_KEY (a .p8 path), APPLE_API_KEY_ID and APPLE_API_ISSUER to notarize");
}
run(builderBin, ["--projectDir", stage, "--config", join(stage, "electron-builder.json"), platform === "mac" ? "--mac" : "--linux", `--${arch}`, "--publish", "never"], { cwd: stage, env });

// ---- checks --------------------------------------------------------------------------------
const unpacked = readdirSync(out)
  .map((d) => join(out, d))
  .filter((d) => d !== stage && statSync(d).isDirectory())
  .flatMap((d) => (platform === "mac" ? readdirSync(d).filter((f) => f.endsWith(".app")).map((f) => join(d, f, "Contents/Resources")) : [join(d, "resources")]))
  .find((d) => existsSync(join(d, "app.asar")));
if (unpacked === undefined) die(`no packaged app.asar under ${out}`);
const asarRequire = createRequire(createRequire(realpathSync(join(DESKTOP, "node_modules/electron-builder/package.json"))).resolve("app-builder-lib/package.json"));
const asar = asarRequire("@electron/asar") as { listPackage(archive: string, options: { isPack: boolean }): string[] };
const entries = asar.listPackage(join(unpacked, "app.asar"), { isPack: false });
for (const need of [PACKAGED_MAIN, PACKAGED_SERVER_CLI, "app/apps/web/dist/index.html", "node_modules/lecturn/dist/bin.mjs", "node_modules/@lecturn/embed/package.json"]) {
  if (!entries.some((e) => e.replaceAll("\\", "/") === `/${need}`)) die(`app.asar lacks ${need}`);
}
for (const need of ["bin/rocketwright", "fixtures/research-vehicle/rocket.rw.toml"]) if (!existsSync(join(unpacked, need))) die(`resources lack ${need}`);
const sdk = [...entries.filter((e) => /\/node_modules\/@cursor\/sdk(-[^/]+)?(\/|$)/.test(e.replaceAll("\\", "/"))), ...cursorSdkDirs(unpacked)];
if (EXCLUDE_CURSOR_SDK && sdk.length > 0) die(`@cursor/sdk is in the package: ${sdk.slice(0, 3).join(", ")}`);

const artifacts = readdirSync(out).filter((f) => /\.(dmg|zip|AppImage)$/.test(f));
if (targets.some((t) => t !== "dir") && artifacts.length === 0) die(`electron-builder wrote no artifact into ${out}`);
console.log(`make package: ${relative(ROOT, unpacked)}${artifacts.length > 0 ? `\n  ${artifacts.map((a) => relative(ROOT, join(out, a))).join("\n  ")}` : ""}`);
