import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { runExecutable } from "../utils/process.js";
const DEFAULT_CONTROL_ROOTS = [".harness/project.yaml", ".harness/agents.source.jsonc", ".harness/generated/agents.json", ".harness/toolchain.yaml", ".harness/toolchain.lock.json", ".harness/policies", ".harness/skills", ".opencode/skills", ".agents/skills", "policies", "skills", "schemas"];
const SELF_CONTROLLER_ROOTS = ["package.json", "package-lock.json", "src/agents", "src/audit", "src/core", "src/delivery", "src/distributed", "src/evals", "src/evidence", "src/issues", "src/mcp", "src/memory", "src/metrics", "src/paseo", "src/policy", "src/provenance", "src/providers", "src/security", "src/telemetry", "src/toolchain", "src/utils", "src/validators", "src/workers"];
export async function createControlPlaneSnapshot(root, config, taskId) {
    const sourceRoot = path.resolve(root);
    const includeRoots = await resolveControlRoots(sourceRoot, config);
    const relativeFiles = await enumerateControlFiles(sourceRoot, includeRoots);
    const outputDir = path.resolve(sourceRoot, config.controlPlane?.snapshotDir ?? ".harness/controller", taskId);
    const materializedRoot = path.join(outputDir, "files");
    await fs.rm(outputDir, { recursive: true, force: true });
    await fs.mkdir(materializedRoot, { recursive: true });
    const files = [];
    for (const relative of relativeFiles) {
        const source = path.resolve(sourceRoot, relative);
        const content = await fs.readFile(source);
        const destination = path.resolve(materializedRoot, relative);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.writeFile(destination, content);
        files.push({ path: relative, sha256: sha256(content), size: content.length });
    }
    const snapshot = { version: 1, taskId, createdAt: new Date().toISOString(), aehVersion: await readPackageVersion(sourceRoot), gitCommit: await readGitCommit(sourceRoot), sourceRoot, materializedRoot, includeRoots, files, compositeSha256: compositeHash(files) };
    await fs.writeFile(path.join(outputDir, "manifest.json"), `${JSON.stringify(snapshot, null, 2)}\n`);
    return snapshot;
}
export async function materializeControlPlaneSnapshot(snapshot, targetRoot, config) {
    const destinationDir = path.resolve(targetRoot, config.controlPlane?.snapshotDir ?? ".harness/controller", snapshot.taskId);
    const destinationFiles = path.join(destinationDir, "files");
    await fs.rm(destinationDir, { recursive: true, force: true });
    await fs.mkdir(path.dirname(destinationDir), { recursive: true });
    await fs.cp(path.dirname(snapshot.materializedRoot), destinationDir, { recursive: true, force: true });
    const materialized = { ...snapshot, materializedRoot: destinationFiles };
    await fs.writeFile(path.join(destinationDir, "manifest.json"), `${JSON.stringify(materialized, null, 2)}\n`);
    return materialized;
}
export async function materializeControlPlaneRuntimeSurface(snapshot, targetRoot) {
    const destinationRoot = path.resolve(targetRoot);
    for (const file of snapshot.files) {
        const source = path.resolve(snapshot.materializedRoot, file.path);
        const destination = path.resolve(destinationRoot, file.path);
        const relative = path.relative(destinationRoot, destination);
        if (relative.startsWith("..") || path.isAbsolute(relative))
            throw new Error(`Control-plane runtime path escapes workspace: ${file.path}`);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.copyFile(source, destination);
    }
}
export async function detectControlPlaneDrift(root, snapshot) {
    const sourceRoot = path.resolve(root);
    const currentFiles = await enumerateControlFiles(sourceRoot, snapshot.includeRoots);
    const expected = new Map(snapshot.files.map((file) => [file.path, file]));
    const currentSet = new Set(currentFiles);
    const changed = [];
    const missing = [];
    const added = [];
    for (const [relative, file] of expected) {
        if (!currentSet.has(relative)) {
            missing.push(relative);
            continue;
        }
        const content = await fs.readFile(path.resolve(sourceRoot, relative));
        if (sha256(content) !== file.sha256)
            changed.push(relative);
    }
    for (const relative of currentFiles)
        if (!expected.has(relative))
            added.push(relative);
    changed.sort();
    missing.sort();
    added.sort();
    return { changed, missing, added, drifted: changed.length + missing.length + added.length > 0 };
}
export async function loadFrozenSkillContext(root, config, taskId, skills) {
    if (!skills.length)
        return undefined;
    const filesRoot = path.resolve(root, config.controlPlane?.snapshotDir ?? ".harness/controller", taskId, "files");
    const roots = [".harness/skills", ".agents/skills", ".opencode/skills", "skills"];
    const chunks = [];
    for (const skill of [...new Set(skills)]) {
        let content;
        for (const rootName of roots) {
            for (const suffix of [path.join(skill, "SKILL.md"), `${skill}.md`]) {
                try {
                    content = await fs.readFile(path.join(filesRoot, rootName, suffix), "utf8");
                    break;
                }
                catch { /* try next frozen root */ }
            }
            if (content !== undefined)
                break;
        }
        if (content !== undefined)
            chunks.push(`## Frozen skill: ${skill}\n${content.trim()}`);
    }
    return chunks.length ? chunks.join("\n\n") : undefined;
}
export function controlPlanePolicyRoot(snapshot) { return snapshot.materializedRoot; }
export async function loadControlPlaneSnapshot(root, config, taskId) { const file = path.resolve(root, config.controlPlane?.snapshotDir ?? ".harness/controller", taskId, "manifest.json"); try {
    return JSON.parse(await fs.readFile(file, "utf8"));
}
catch {
    return undefined;
} }
async function resolveControlRoots(root, config) { const configured = [config.agents?.configPath, config.agents?.generatedPath, config.toolchain?.configPath, config.toolchain?.lockPath, ...(config.validation?.opa?.policyDirs ?? []), config.organization?.policyBundles?.cacheDir, ...(config.controlPlane?.include ?? [])].filter((value) => Boolean(value)); const self = await isHarnessRepository(root) ? SELF_CONTROLLER_ROOTS : []; return [...new Set([...DEFAULT_CONTROL_ROOTS, ...configured, ...self].map(normalizeRelative))].sort(); }
async function isHarnessRepository(root) { try {
    const value = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
    return value.name === "agentic-engineering-harness";
}
catch {
    return false;
} }
async function enumerateControlFiles(root, includeRoots) { const result = new Set(); for (const relative of includeRoots)
    await collectPath(root, relative, result); return [...result].sort(); }
async function collectPath(root, relative, result) { const absolute = path.resolve(root, relative); if (!inside(root, absolute))
    throw new Error(`Control-plane snapshot path escapes project root: ${relative}`); let stat; try {
    stat = await fs.stat(absolute);
}
catch {
    return;
} if (stat.isFile()) {
    result.add(normalizeRelative(path.relative(root, absolute)));
    return;
} if (!stat.isDirectory())
    return; const entries = await fs.readdir(absolute, { withFileTypes: true }); for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (["node_modules", ".git", "dist"].includes(entry.name))
        continue;
    await collectPath(root, normalizeRelative(path.relative(root, path.join(absolute, entry.name))), result);
} }
function compositeHash(files) { const hash = crypto.createHash("sha256"); for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path)))
    hash.update(`${file.path}\0${file.sha256}\0${file.size}\n`); return hash.digest("hex"); }
async function readPackageVersion(root) { try {
    return JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")).version;
}
catch {
    return undefined;
} }
async function readGitCommit(root) { const result = await runExecutable("git", ["rev-parse", "HEAD"], { cwd: root, timeoutMs: 10_000 }); return result.exitCode === 0 ? result.stdout.trim() || undefined : undefined; }
function normalizeRelative(value) { return value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, ""); }
function inside(root, target) { const relative = path.relative(path.resolve(root), target); return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)); }
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
//# sourceMappingURL=controlPlane.js.map