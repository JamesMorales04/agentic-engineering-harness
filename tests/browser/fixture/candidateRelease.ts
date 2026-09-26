import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface CandidateBuildIdentityV1 {
  version: 1;
  packageVersion: string;
  gitSha: string;
  releaseId: string;
  buildDigest: string;
  dirty: boolean;
}

export interface CandidateReleaseResolution {
  repoRoot: string;
  distRoot: string;
  releaseDir: string;
  identity: CandidateBuildIdentityV1;
}

export class CandidateUnavailableError extends Error {
  readonly classification = "TEST_INFRASTRUCTURE_UNAVAILABLE";
  constructor(message: string) {
    super(message);
    this.name = "CandidateUnavailableError";
  }
}

const REQUIRED_RELEASE_MODULES = [
  "operations/state.js",
  "operations/portfolio.js",
  "operations/controller.js",
  "architecture/executionIdentity.js",
  "security/humanDecision.js",
  "core/config.js",
  "core/digest.js"
] as const;

function candidateRoots(specFileUrl: string, cwd: string): string[] {
  const roots: string[] = [];
  const seen = new Set<string>();
  const push = (value: string) => {
    const resolved = path.resolve(value);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    roots.push(resolved);
  };
  if (process.env.AEH_S9_REPO_ROOT?.trim()) push(process.env.AEH_S9_REPO_ROOT.trim());
  for (const start of [path.resolve(cwd), path.dirname(fileURLToPath(specFileUrl))]) {
    let current = start;
    for (;;) {
      push(current);
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return roots;
}

async function readJson(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function asIdentity(value: Record<string, unknown> | undefined): CandidateBuildIdentityV1 | undefined {
  if (!value) return undefined;
  if (value.version !== 1) return undefined;
  for (const key of ["packageVersion", "gitSha", "releaseId", "buildDigest"] as const) {
    if (typeof value[key] !== "string" || !(value[key] as string).trim()) return undefined;
  }
  if (typeof value.dirty !== "boolean" || !/^[a-f0-9]{64}$/.test(value.buildDigest as string)) return undefined;
  return value as unknown as CandidateBuildIdentityV1;
}

export async function resolveCandidateRelease(options: { specFileUrl: string; cwd: string }): Promise<CandidateReleaseResolution> {
  const checked: string[] = [];
  for (const root of candidateRoots(options.specFileUrl, options.cwd)) {
    const pkg = await readJson(path.join(root, "package.json"));
    if (pkg?.name !== "agentic-engineering-harness") continue;
    checked.push(root);
    const releaseId = await fs.readFile(path.join(root, "dist", "current"), "utf8").then((value) => value.trim()).catch(() => undefined);
    if (!releaseId || !/^[A-Za-z0-9._-]+$/.test(releaseId)) continue;
    const distRoot = path.join(root, "dist");
    const releaseDir = path.join(distRoot, "releases", releaseId);
    const identity = asIdentity(await readJson(path.join(releaseDir, "build-identity.json")));
    if (!identity) continue;
    const missing: string[] = [];
    for (const relative of REQUIRED_RELEASE_MODULES) {
      try {
        await fs.access(path.join(releaseDir, relative));
      } catch {
        missing.push(relative);
      }
    }
    if (missing.length) {
      throw new CandidateUnavailableError(`candidate release ${releaseId} at ${releaseDir} is missing required modules: ${missing.join(", ")}.`);
    }
    try {
      await fs.access(path.join(releaseDir, "ui", "control-center", "dist", "index.html"));
    } catch {
      throw new CandidateUnavailableError(`candidate release ${releaseId} at ${releaseDir} does not embed a Control Center frontend build.`);
    }
    return { repoRoot: root, distRoot, releaseDir, identity };
  }
  throw new CandidateUnavailableError(
    `no built AEH candidate release was found. Checked package roots: ${checked.length ? checked.join(", ") : "(none matched package name agentic-engineering-harness)"}. `
    + "Run npm ci && npm run build in the campaign checkout, or set AEH_S9_REPO_ROOT to the checkout whose dist/current should be tested."
  );
}

const moduleCache = new Map<string, Promise<unknown>>();

export async function loadReleaseModule<T>(releaseDir: string, relativePath: string): Promise<T> {
  const key = `${releaseDir}\0${relativePath}`;
  const cached = moduleCache.get(key);
  if (cached) return cached as Promise<T>;
  const load = import(pathToFileURL(path.join(releaseDir, relativePath)).href) as Promise<T>;
  moduleCache.set(key, load);
  try {
    return await load;
  } catch (error) {
    moduleCache.delete(key);
    throw new CandidateUnavailableError(`failed to load candidate release module ${relativePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
