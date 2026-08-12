import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { HarnessProjectConfig } from "./types.js";
import { runProcess } from "../utils/process.js";

export interface ControlPlaneFile { path: string; sha256: string; size: number; }
export interface ControlPlaneSnapshot { version: 1; taskId: string; createdAt: string; aehVersion?: string; gitCommit?: string; sourceRoot: string; materializedRoot: string; includeRoots: string[]; files: ControlPlaneFile[]; compositeSha256: string; }
export interface ControlPlaneDrift { changed: string[]; missing: string[]; added: string[]; drifted: boolean; }

const DEFAULT_CONTROL_ROOTS = [".harness/project.yaml", ".harness/agents.source.jsonc", ".harness/generated/agents.json", ".harness/toolchain.yaml", ".harness/toolchain.lock.json", ".harness/policies", ".harness/skills", ".opencode/skills", ".agents/skills", "policies", "skills", "schemas"];
const SELF_CONTROLLER_ROOTS = ["package.json", "package-lock.json", "src/agents", "src/core", "src/toolchain", "src/validators", "src/workers"];

export async function createControlPlaneSnapshot(root: string, config: HarnessProjectConfig, taskId: string): Promise<ControlPlaneSnapshot> {
  const sourceRoot = path.resolve(root); const includeRoots = await resolveControlRoots(sourceRoot, config); const relativeFiles = await enumerateControlFiles(sourceRoot, includeRoots); const outputDir = path.resolve(sourceRoot, config.controlPlane?.snapshotDir ?? ".harness/controller", taskId); const materializedRoot = path.join(outputDir, "files");
  await fs.rm(outputDir, { recursive: true, force: true }); await fs.mkdir(materializedRoot, { recursive: true });
  const files: ControlPlaneFile[] = [];
  for (const relative of relativeFiles) { const source = path.resolve(sourceRoot, relative); const content = await fs.readFile(source); const destination = path.resolve(materializedRoot, relative); await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.writeFile(destination, content); files.push({ path: relative, sha256: sha256(content), size: content.length }); }
  const snapshot: ControlPlaneSnapshot = { version: 1, taskId, createdAt: new Date().toISOString(), aehVersion: await readPackageVersion(sourceRoot), gitCommit: await readGitCommit(sourceRoot), sourceRoot, materializedRoot, includeRoots, files, compositeSha256: compositeHash(files) };
  await fs.writeFile(path.join(outputDir, "manifest.json"), `${JSON.stringify(snapshot, null, 2)}\n`); return snapshot;
}

export async function materializeControlPlaneSnapshot(snapshot: ControlPlaneSnapshot, targetRoot: string, config: HarnessProjectConfig): Promise<ControlPlaneSnapshot> {
  const destinationDir = path.resolve(targetRoot, config.controlPlane?.snapshotDir ?? ".harness/controller", snapshot.taskId); const destinationFiles = path.join(destinationDir, "files"); await fs.rm(destinationDir, { recursive: true, force: true }); await fs.mkdir(path.dirname(destinationDir), { recursive: true }); await fs.cp(path.dirname(snapshot.materializedRoot), destinationDir, { recursive: true, force: true }); const materialized: ControlPlaneSnapshot = { ...snapshot, materializedRoot: destinationFiles }; await fs.writeFile(path.join(destinationDir, "manifest.json"), `${JSON.stringify(materialized, null, 2)}\n`); return materialized;
}

export async function detectControlPlaneDrift(root: string, snapshot: ControlPlaneSnapshot): Promise<ControlPlaneDrift> {
  const sourceRoot = path.resolve(root); const currentFiles = await enumerateControlFiles(sourceRoot, snapshot.includeRoots); const expected = new Map(snapshot.files.map((file) => [file.path, file])); const currentSet = new Set(currentFiles); const changed: string[] = []; const missing: string[] = []; const added: string[] = [];
  for (const [relative, file] of expected) { if (!currentSet.has(relative)) { missing.push(relative); continue; } const content = await fs.readFile(path.resolve(sourceRoot, relative)); if (sha256(content) !== file.sha256) changed.push(relative); }
  for (const relative of currentFiles) if (!expected.has(relative)) added.push(relative); changed.sort(); missing.sort(); added.sort(); return { changed, missing, added, drifted: changed.length + missing.length + added.length > 0 };
}
export function controlPlanePolicyRoot(snapshot: ControlPlaneSnapshot): string { return snapshot.materializedRoot; }
export async function loadControlPlaneSnapshot(root: string, config: HarnessProjectConfig, taskId: string): Promise<ControlPlaneSnapshot | undefined> { const file = path.resolve(root, config.controlPlane?.snapshotDir ?? ".harness/controller", taskId, "manifest.json"); try { return JSON.parse(await fs.readFile(file, "utf8")) as ControlPlaneSnapshot; } catch { return undefined; } }

async function resolveControlRoots(root: string, config: HarnessProjectConfig): Promise<string[]> {
  const configured = [config.agents?.configPath, config.agents?.generatedPath, config.toolchain?.configPath, config.toolchain?.lockPath, ...(config.validation?.opa?.policyDirs ?? []), config.organization?.policyBundles?.cacheDir, ...(config.controlPlane?.include ?? [])].filter((value): value is string => Boolean(value));
  const self = await isHarnessRepository(root) ? SELF_CONTROLLER_ROOTS : []; return [...new Set([...DEFAULT_CONTROL_ROOTS, ...configured, ...self].map(normalizeRelative))].sort();
}
async function isHarnessRepository(root: string): Promise<boolean> { try { const value = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")) as { name?: string }; return value.name === "agentic-engineering-harness"; } catch { return false; } }
async function enumerateControlFiles(root: string, includeRoots: string[]): Promise<string[]> { const result = new Set<string>(); for (const relative of includeRoots) await collectPath(root, relative, result); return [...result].sort(); }
async function collectPath(root: string, relative: string, result: Set<string>): Promise<void> { const absolute = path.resolve(root, relative); if (!inside(root, absolute)) throw new Error(`Control-plane snapshot path escapes project root: ${relative}`); let stat; try { stat = await fs.stat(absolute); } catch { return; } if (stat.isFile()) { result.add(normalizeRelative(path.relative(root, absolute))); return; } if (!stat.isDirectory()) return; const entries = await fs.readdir(absolute, { withFileTypes: true }); for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) { if (["node_modules", ".git", "dist"].includes(entry.name)) continue; const child = normalizeRelative(path.relative(root, path.join(absolute, entry.name))); if (child.startsWith(normalizeRelative(path.join(configlessControllerRoot(), "dummy")))) { /* no-op marker for tree-shake-safe helper */ } await collectPath(root, child, result); } }
function configlessControllerRoot(): string { return ".harness/controller"; }
function compositeHash(files: ControlPlaneFile[]): string { const hash = crypto.createHash("sha256"); for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) hash.update(`${file.path}\0${file.sha256}\0${file.size}\n`); return hash.digest("hex"); }
async function readPackageVersion(root: string): Promise<string | undefined> { try { return (JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")) as { version?: string }).version; } catch { return undefined; } }
async function readGitCommit(root: string): Promise<string | undefined> { const result = await runProcess("git rev-parse HEAD", { cwd: root, timeoutMs: 10_000 }); return result.exitCode === 0 ? result.stdout.trim() || undefined : undefined; }
function normalizeRelative(value: string): string { return value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, ""); }
function inside(root: string, target: string): boolean { const relative = path.relative(path.resolve(root), target); return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)); }
function sha256(value: Buffer | string): string { return crypto.createHash("sha256").update(value).digest("hex"); }
