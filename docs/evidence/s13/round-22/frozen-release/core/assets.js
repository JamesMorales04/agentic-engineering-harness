import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { PACKAGE_ROOT, VERSION } from "../version.js";
const MANIFEST_PATH = ".harness/managed-assets.json";
const MANAGED_ROOTS = [
    { source: "skills", destination: ".harness/skills" },
    { source: "policies/core", destination: ".harness/policies/core" }
];
export async function reconcileHarnessAssets(root, options = {}) {
    const projectRoot = path.resolve(root);
    const sourceRoot = options.packageRoot ?? PACKAGE_ROOT;
    const manifestFile = path.join(projectRoot, MANIFEST_PATH);
    const previous = await loadManifest(manifestFile);
    const next = { version: 1, aehVersion: options.aehVersion ?? VERSION, assets: {} };
    const result = { manifestPath: MANIFEST_PATH, created: [], updated: [], removed: [], preservedOverrides: [], unchanged: [] };
    for (const managedRoot of MANAGED_ROOTS) {
        const packageRoot = path.join(sourceRoot, managedRoot.source);
        if (!(await exists(packageRoot)))
            continue;
        const files = await listFiles(packageRoot);
        for (const sourceFile of files) {
            const relative = normalize(path.relative(packageRoot, sourceFile));
            const destinationRelative = normalize(path.join(managedRoot.destination, relative));
            const destinationFile = path.join(projectRoot, destinationRelative);
            const sourceBytes = await fs.readFile(sourceFile);
            const sourceSha256 = sha256(sourceBytes);
            const prior = previous?.assets[destinationRelative];
            const destinationBytes = await fs.readFile(destinationFile).catch(() => undefined);
            if (!destinationBytes) {
                await writeManagedFile(destinationFile, sourceBytes);
                next.assets[destinationRelative] = { sourceSha256, managedSha256: sourceSha256 };
                result.created.push(destinationRelative);
                continue;
            }
            const destinationSha256 = sha256(destinationBytes);
            if (destinationSha256 === sourceSha256) {
                next.assets[destinationRelative] = { sourceSha256, managedSha256: sourceSha256 };
                result.unchanged.push(destinationRelative);
                continue;
            }
            if (prior?.managedSha256 && destinationSha256 === prior.managedSha256) {
                await writeManagedFile(destinationFile, sourceBytes);
                next.assets[destinationRelative] = { sourceSha256, managedSha256: sourceSha256 };
                result.updated.push(destinationRelative);
                continue;
            }
            next.assets[destinationRelative] = {
                sourceSha256,
                managedSha256: prior?.managedSha256,
                overridden: true
            };
            result.preservedOverrides.push(destinationRelative);
        }
    }
    for (const [destinationRelative, prior] of Object.entries(previous?.assets ?? {})) {
        if (next.assets[destinationRelative])
            continue;
        const destinationFile = path.join(projectRoot, destinationRelative);
        const destinationBytes = await fs.readFile(destinationFile).catch(() => undefined);
        if (!destinationBytes)
            continue;
        const destinationSha256 = sha256(destinationBytes);
        if (prior.managedSha256 && destinationSha256 === prior.managedSha256 && !prior.overridden) {
            await fs.rm(destinationFile, { force: true });
            result.removed.push(destinationRelative);
            continue;
        }
        next.assets[destinationRelative] = { ...prior, overridden: true };
        result.preservedOverrides.push(destinationRelative);
    }
    await fs.mkdir(path.dirname(manifestFile), { recursive: true });
    await fs.writeFile(manifestFile, `${JSON.stringify(next, null, 2)}\n`);
    return result;
}
async function loadManifest(file) {
    try {
        const parsed = JSON.parse(await fs.readFile(file, "utf8"));
        return parsed.version === 1 && parsed.assets && typeof parsed.assets === "object" ? parsed : undefined;
    }
    catch {
        return undefined;
    }
}
async function listFiles(directory) {
    const result = [];
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const item = path.join(directory, entry.name);
        if (entry.isDirectory())
            result.push(...await listFiles(item));
        else if (entry.isFile())
            result.push(item);
    }
    return result.sort();
}
async function writeManagedFile(file, content) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
}
async function exists(file) {
    try {
        await fs.access(file);
        return true;
    }
    catch {
        return false;
    }
}
function sha256(content) {
    return crypto.createHash("sha256").update(content).digest("hex");
}
function normalize(value) {
    return value.replaceAll("\\", "/");
}
//# sourceMappingURL=assets.js.map