import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { PACKAGE_ROOT, VERSION } from "../version.js";

const MANIFEST_PATH = ".harness/managed-assets.json";

interface ManagedAssetEntry {
  sourceSha256: string;
  managedSha256?: string;
  overridden?: boolean;
}

interface ManagedAssetManifest {
  version: 1;
  aehVersion: string;
  assets: Record<string, ManagedAssetEntry>;
}

export interface HarnessAssetReconcileResult {
  manifestPath: string;
  created: string[];
  updated: string[];
  preservedOverrides: string[];
  unchanged: string[];
}

export interface HarnessAssetReconcileOptions {
  packageRoot?: string;
  aehVersion?: string;
}

const MANAGED_ROOTS = [
  { source: "skills", destination: ".harness/skills" },
  { source: "policies/core", destination: ".harness/policies/core" }
] as const;

export async function reconcileHarnessAssets(root: string, options: HarnessAssetReconcileOptions = {}): Promise<HarnessAssetReconcileResult> {
  const projectRoot = path.resolve(root);
  const sourceRoot = options.packageRoot ?? PACKAGE_ROOT;
  const manifestFile = path.join(projectRoot, MANIFEST_PATH);
  const previous = await loadManifest(manifestFile);
  const next: ManagedAssetManifest = { version: 1, aehVersion: options.aehVersion ?? VERSION, assets: {} };
  const result: HarnessAssetReconcileResult = { manifestPath: MANIFEST_PATH, created: [], updated: [], preservedOverrides: [], unchanged: [] };

  for (const managedRoot of MANAGED_ROOTS) {
    const packageRoot = path.join(sourceRoot, managedRoot.source);
    if (!(await exists(packageRoot))) continue;
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

  await fs.mkdir(path.dirname(manifestFile), { recursive: true });
  await fs.writeFile(manifestFile, `${JSON.stringify(next, null, 2)}\n`);
  return result;
}

async function loadManifest(file: string): Promise<ManagedAssetManifest | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as ManagedAssetManifest;
    return parsed.version === 1 && parsed.assets && typeof parsed.assets === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function listFiles(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const item = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await listFiles(item));
    else if (entry.isFile()) result.push(item);
  }
  return result.sort();
}

async function writeManagedFile(file: string, content: Buffer): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

async function exists(file: string): Promise<boolean> {
  try { await fs.access(file); return true; } catch { return false; }
}

function sha256(content: Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function normalize(value: string): string {
  return value.replaceAll("\\", "/");
}
