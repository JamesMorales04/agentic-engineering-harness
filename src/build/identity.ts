import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface BuildIdentityV1 {
  version: 1;
  packageVersion: string;
  gitSha: string;
  releaseId: string;
  buildDigest: string;
  dirty: boolean;
}

let cached: BuildIdentityV1 | undefined;

/** One immutable identity for the running AEH build. */
export function getBuildIdentity(): BuildIdentityV1 {
  if (cached) return cached;
  let current = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth += 1) {
    const identityFile = path.join(current, "build-identity.json");
    if (existsSync(identityFile)) {
      const parsed: unknown = JSON.parse(readFileSync(identityFile, "utf8"));
      if (!isBuildIdentityV1(parsed)) throw new Error(`Invalid AEH BuildIdentity at ${identityFile}.`);
      cached = Object.freeze(parsed);
      return cached;
    }
    const packageFile = path.join(current, "package.json");
    if (existsSync(packageFile)) {
      const pkg = JSON.parse(readFileSync(packageFile, "utf8")) as { name?: string; version?: string };
      if (pkg.name === "agentic-engineering-harness" && typeof pkg.version === "string") {
        const packageVersion = pkg.version;
        const releaseId = "development";
        cached = Object.freeze({
          version: 1,
          packageVersion,
          gitSha: process.env.AEH_BUILD_GIT_SHA ?? "unknown",
          releaseId,
          buildDigest: createHash("sha256").update(`${pkg.name}\0${packageVersion}\0${releaseId}`).digest("hex"),
          dirty: true
        });
        return cached;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error("Unable to resolve the running AEH BuildIdentity.");
}

export function isBuildIdentityV1(value: unknown): value is BuildIdentityV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const identity = value as Partial<BuildIdentityV1>;
  return identity.version === 1
    && typeof identity.packageVersion === "string"
    && typeof identity.gitSha === "string"
    && typeof identity.releaseId === "string"
    && typeof identity.buildDigest === "string" && /^[a-f0-9]{64}$/.test(identity.buildDigest)
    && typeof identity.dirty === "boolean";
}
