import fs from "node:fs/promises";
import path from "node:path";
import { PACKAGE_ROOT } from "../version.js";

interface PackageIdentity {
  name?: unknown;
  repository?: unknown;
}

/**
 * Source checkouts use their tracked configuration as the canonical source.
 * A consumer checkout is identified by the package name and repository URL,
 * plus Git metadata; the directory name is deliberately irrelevant.
 */
export async function isAehSourceCheckout(
  projectRoot: string,
  packageRoot = PACKAGE_ROOT
): Promise<boolean> {
  const root = path.resolve(projectRoot);
  if (!(await exists(path.join(root, ".git")))) return false;

  const [projectIdentity, packageIdentity] = await Promise.all([
    readPackageIdentity(root),
    readPackageIdentity(packageRoot)
  ]);
  if (!projectIdentity || !packageIdentity || typeof packageIdentity.name !== "string") return false;
  if (projectIdentity.name !== packageIdentity.name) return false;

  const projectRepository = repositoryUrl(projectIdentity.repository);
  const packageRepository = repositoryUrl(packageIdentity.repository);
  return Boolean(projectRepository && packageRepository && projectRepository === packageRepository);
}

async function readPackageIdentity(root: string): Promise<PackageIdentity | undefined> {
  try {
    return JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")) as PackageIdentity;
  } catch {
    return undefined;
  }
}

function repositoryUrl(repository: unknown): string | undefined {
  const raw = typeof repository === "string"
    ? repository
    : repository && typeof repository === "object" && "url" in repository && typeof repository.url === "string"
      ? repository.url
      : undefined;
  if (!raw) return undefined;
  return raw.trim()
    .replace(/^git\+/, "")
    .replace(/^git@([^:]+):/, "https://$1/")
    .replace(/\.git\/?$/i, "")
    .replace(/\/$/, "")
    .toLowerCase();
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}
