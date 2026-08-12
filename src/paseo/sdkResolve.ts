import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { runProcess, type ProcessResult } from "../utils/process.js";

const PASEO_CLIENT_PACKAGE = "@getpaseo/client";
const MAX_PHYSICAL_SCAN_DEPTH = 8;
const MAX_PHYSICAL_SCAN_DIRS = 10_000;

type ProcessRunner = (command: string, options: Parameters<typeof runProcess>[1]) => Promise<ProcessResult>;

export interface PaseoSdkResolution {
  resolved?: string;
  diagnostics: string[];
}

/**
 * Resolve the Paseo client that belongs to the active Paseo CLI installation.
 *
 * mise's npm backend may expose a shim/alias path and package managers may
 * materialize transitive dependencies in non-hoisted stores. Prefer normal
 * Node resolution because it is cheap and semantically correct. If that fails,
 * scan only the bounded Paseo installation prefixes and load the exact
 * @getpaseo/client package physically present there.
 */
export async function resolvePaseoSdkFromCli(root: string, runner: ProcessRunner = runProcess): Promise<PaseoSdkResolution> {
  const diagnostics: string[] = [];
  const starts = new Set<string>();
  const installRoots = new Set<string>();

  const commandPath = await capturePath(runner, "command -v paseo", root, "command -v paseo", diagnostics);
  if (commandPath) {
    await addExecutableStarts(starts, commandPath);
    const inferred = inferMiseInstallRoot(commandPath);
    if (inferred) installRoots.add(inferred);
  }

  const misePath = await capturePath(runner, "mise which paseo", root, "mise which paseo", diagnostics);
  if (misePath) {
    await addExecutableStarts(starts, misePath);
    const inferred = inferMiseInstallRoot(misePath);
    if (inferred) installRoots.add(inferred);
  }

  const miseRoot = await capturePath(runner, "mise where 'npm:@getpaseo/cli'", root, "mise where npm:@getpaseo/cli", diagnostics);
  if (miseRoot) {
    const absolute = path.resolve(miseRoot);
    starts.add(absolute);
    installRoots.add(absolute);
  }

  for (const start of starts) {
    const resolved = resolvePackageWalkingUp(start, PASEO_CLIENT_PACKAGE);
    if (resolved) {
      diagnostics.push(`node resolution: ${resolved}`);
      return { resolved, diagnostics };
    }
  }

  for (const installRoot of installRoots) {
    const resolved = await resolvePackagePhysically(installRoot, diagnostics);
    if (resolved) return { resolved, diagnostics };
  }

  return { diagnostics };
}

async function capturePath(runner: ProcessRunner, command: string, root: string, label: string, diagnostics: string[]): Promise<string | undefined> {
  try {
    const result = await runner(command, { cwd: root, timeoutMs: 15_000 });
    const value = result.exitCode === 0 ? lastNonEmptyLine(result.stdout) : undefined;
    diagnostics.push(`${label}: ${value ?? `unavailable (exit ${result.exitCode})`}`);
    return value;
  } catch (error) {
    diagnostics.push(`${label}: ${String(error)}`);
    return undefined;
  }
}

async function addExecutableStarts(starts: Set<string>, executable: string): Promise<void> {
  const absolute = path.resolve(executable);
  starts.add(path.dirname(absolute));
  const real = await fs.realpath(absolute).catch(() => absolute);
  starts.add(path.dirname(real));
}

function inferMiseInstallRoot(executable: string): string | undefined {
  const absolute = path.resolve(executable);
  const marker = `${path.sep}installs${path.sep}npm-getpaseo-cli${path.sep}`;
  const markerIndex = absolute.indexOf(marker);
  if (markerIndex < 0) return undefined;
  const versionStart = markerIndex + marker.length;
  const remainder = absolute.slice(versionStart);
  const versionOrAlias = remainder.split(path.sep)[0];
  if (!versionOrAlias) return undefined;
  return absolute.slice(0, versionStart + versionOrAlias.length);
}

function resolvePackageWalkingUp(start: string, packageName: string): string | undefined {
  let current = path.resolve(start);
  for (let depth = 0; depth < 12; depth += 1) {
    try {
      const resolver = createRequire(path.join(current, "__aeh_paseo_sdk_loader__.cjs"));
      return resolver.resolve(packageName);
    } catch { /* keep walking toward the npm synthetic-project root */ }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

async function resolvePackagePhysically(installRoot: string, diagnostics: string[]): Promise<string | undefined> {
  const root = path.resolve(installRoot);
  diagnostics.push(`physical scan root: ${root}`);

  const directManifests = [
    path.join(root, "node_modules", "@getpaseo", "client", "package.json"),
    path.join(root, "node_modules", "@getpaseo", "cli", "node_modules", "@getpaseo", "client", "package.json")
  ];
  for (const manifest of directManifests) {
    const entry = await entryFromPackageManifest(manifest);
    if (entry) {
      diagnostics.push(`physical client: ${manifest}`);
      return entry;
    }
  }

  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  const seen = new Set<string>();
  let scanned = 0;

  while (queue.length && scanned < MAX_PHYSICAL_SCAN_DIRS) {
    const next = queue.shift()!;
    if (next.depth > MAX_PHYSICAL_SCAN_DEPTH) continue;
    const real = await fs.realpath(next.dir).catch(() => next.dir);
    if (seen.has(real)) continue;
    seen.add(real);
    scanned += 1;

    const manifest = path.join(next.dir, "node_modules", "@getpaseo", "client", "package.json");
    const entry = await entryFromPackageManifest(manifest);
    if (entry) {
      diagnostics.push(`physical client: ${manifest}`);
      return entry;
    }

    let children: Awaited<ReturnType<typeof fs.readdir>>;
    try {
      children = await fs.readdir(next.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children) {
      if (!child.isDirectory() && !child.isSymbolicLink()) continue;
      if (child.name === ".git" || child.name === "dist" || child.name === "bin") continue;
      queue.push({ dir: path.join(next.dir, child.name), depth: next.depth + 1 });
    }
  }

  diagnostics.push(`physical scan exhausted: ${root} (${scanned} dirs)`);
  return undefined;
}

async function entryFromPackageManifest(manifest: string): Promise<string | undefined> {
  let raw: string;
  try { raw = await fs.readFile(manifest, "utf8"); }
  catch { return undefined; }

  let pkg: Record<string, unknown>;
  try { pkg = JSON.parse(raw) as Record<string, unknown>; }
  catch { return undefined; }
  if (pkg.name !== PASEO_CLIENT_PACKAGE) return undefined;

  const relative = packageEntry(pkg);
  if (!relative) return undefined;
  const entry = path.resolve(path.dirname(manifest), relative);
  try { await fs.access(entry); return entry; }
  catch { return undefined; }
}

function packageEntry(pkg: Record<string, unknown>): string | undefined {
  const exportsField = pkg.exports;
  if (typeof exportsField === "string") return exportsField;
  if (exportsField && typeof exportsField === "object" && !Array.isArray(exportsField)) {
    const exportsRecord = exportsField as Record<string, unknown>;
    const rootExport = exportsRecord["."] ?? exportsRecord;
    if (typeof rootExport === "string") return rootExport;
    if (rootExport && typeof rootExport === "object" && !Array.isArray(rootExport)) {
      const conditions = rootExport as Record<string, unknown>;
      for (const key of ["import", "default", "require"]) {
        if (typeof conditions[key] === "string") return conditions[key] as string;
      }
    }
  }
  if (typeof pkg.module === "string") return pkg.module;
  if (typeof pkg.main === "string") return pkg.main;
  return "index.js";
}

function lastNonEmptyLine(value: string): string | undefined {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1);
}
