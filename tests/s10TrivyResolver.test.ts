import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveTrivyPath } from "../scripts/s10-trivy-resolver.mjs";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("S10 real SAST scanner resolution", () => {
  it("finds a real scanner file through PATH", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-s10-trivy-path-"));
    temporaryRoots.push(root);
    const binary = path.join(root, "trivy");
    await fs.writeFile(binary, "scanner fixture\n");
    await fs.chmod(binary, 0o755);

    expect(resolveTrivyPath(undefined, root)).toBe(binary);
  });

  it("honors only an executable explicit scanner and keeps missing providers unresolved", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-s10-trivy-explicit-"));
    temporaryRoots.push(root);
    const binary = path.join(root, "trivy");
    await fs.writeFile(binary, "scanner fixture\n");
    await fs.chmod(binary, 0o755);
    const nonExecutable = path.join(root, "not-executable");
    await fs.writeFile(nonExecutable, "not a scanner\n");

    expect(resolveTrivyPath(binary, "")).toBe(binary);
    expect(resolveTrivyPath(nonExecutable, "")).toBeUndefined();
    expect(resolveTrivyPath(path.join(root, "missing"), "")).toBeUndefined();
    expect(resolveTrivyPath(undefined, "/path/that/does/not/exist")).toBeUndefined();
  });
});
