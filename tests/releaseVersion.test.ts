import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { chooseBumpFromMessages, incrementVersion, resolveTargetVersion } from "../scripts/release-version.mjs";

const exec = promisify(execFile);

describe("release version resolver", () => {
  it("maps conventional commits to semantic bumps", () => {
    expect(chooseBumpFromMessages(["fix: repair start"])).toBe("patch");
    expect(chooseBumpFromMessages(["feat: add worker status"])).toBe("minor");
    expect(chooseBumpFromMessages(["feat!: replace public contract"])).toBe("major");
    expect(chooseBumpFromMessages(["feat: change\n\nBREAKING CHANGE: old API removed"])).toBe("major");
  });

  it("publishes an explicitly unshipped repository version before incrementing again", () => {
    expect(resolveTargetVersion({ currentVersion: "0.6.1", currentPublished: false, requestedBump: "auto", messages: ["feat: ignored until current ships"] })).toEqual(expect.objectContaining({ version: "0.6.1", bump: "current", shouldPublish: true }));
    expect(resolveTargetVersion({ currentVersion: "0.6.1", currentPublished: true, requestedBump: "auto", messages: ["fix: next change"] })).toEqual(expect.objectContaining({ version: "0.6.2", bump: "patch", shouldPublish: true }));
  });

  it("increments major, minor and patch versions deterministically", () => {
    expect(incrementVersion("0.6.1", "patch")).toBe("0.6.2");
    expect(incrementVersion("0.6.1", "minor")).toBe("0.7.0");
    expect(incrementVersion("0.6.1", "major")).toBe("1.0.0");
  });

  it("resolves X+1, synchronizes isolated package metadata, and keeps build identity strict", async () => {
    const repositoryPackage = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8")) as Record<string, unknown> & { name: string; version: string };
    const repositoryLock = JSON.parse(await fs.readFile(new URL("../package-lock.json", import.meta.url), "utf8")) as Record<string, unknown> & { version: string; packages: Record<string, unknown> };
    const resolution = resolveTargetVersion({
      currentVersion: repositoryPackage.version,
      currentPublished: true,
      requestedBump: "auto",
      messages: ["fix: exercise release candidate version identity"]
    });
    expect(resolution.version).toBe(incrementVersion(repositoryPackage.version, "patch"));

    const candidateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-release-candidate-"));
    try {
      const candidatePackageInput = { ...repositoryPackage, version: repositoryPackage.version };
      const candidateLockInput = {
        ...repositoryLock,
        version: repositoryPackage.version,
        packages: {
          ...repositoryLock.packages,
          "": { ...(repositoryLock.packages[""] as Record<string, unknown>), version: repositoryPackage.version }
        }
      };
      await fs.writeFile(path.join(candidateRoot, "package.json"), `${JSON.stringify(candidatePackageInput, null, 2)}\n`);
      await fs.writeFile(path.join(candidateRoot, "package-lock.json"), `${JSON.stringify(candidateLockInput, null, 2)}\n`);
      await exec("npm", ["version", resolution.version, "--no-git-tag-version", "--allow-same-version", "--ignore-scripts"], { cwd: candidateRoot });

      const candidatePackage = JSON.parse(await fs.readFile(path.join(candidateRoot, "package.json"), "utf8")) as { version: string };
      const candidateLock = JSON.parse(await fs.readFile(path.join(candidateRoot, "package-lock.json"), "utf8")) as { version: string; packages: { "": { version: string } } };
      expect(candidatePackage.version).toBe(resolution.version);
      expect(candidateLock.version).toBe(resolution.version);
      expect(candidateLock.packages[""].version).toBe(resolution.version);

      // A strict identity comparison against the previous version must reject
      // the synchronized candidate. The release:check corpus regression
      // independently compares the running BuildIdentity to canonical VERSION.
      expect(repositoryPackage.version).not.toBe(candidatePackage.version);
      expect(candidatePackage.version).toBe(resolution.version);

      const packageAfter = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
      const lockAfter = JSON.parse(await fs.readFile(new URL("../package-lock.json", import.meta.url), "utf8")) as { version: string };
      expect(packageAfter.version).toBe(repositoryPackage.version);
      expect(lockAfter.version).toBe(repositoryPackage.version);
    } finally {
      await fs.rm(candidateRoot, { recursive: true, force: true });
    }
  });
});
