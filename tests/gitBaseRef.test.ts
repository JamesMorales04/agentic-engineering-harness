import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveCommit } from "../src/core/git.js";
import { buildBranchOffWorkspaceCommand } from "../src/operations/controller.js";
import type { HarnessProjectConfig } from "../src/core/types.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function gitRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-base-ref-"));
  roots.push(root);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "aeh@example.test"], { cwd: root });
  execFileSync("git", ["config", "user.name", "AEH Test"], { cwd: root });
  await fs.writeFile(path.join(root, "file.txt"), "v1\n");
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "one"], { cwd: root });
  return root;
}

describe("workspace base commit resolution (DETERMINISTIC)", () => {
  it("pins branch names to exact SHAs and reports unresolvable refs", async () => {
    const root = await gitRepo();
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    expect(await resolveCommit(root, "main")).toBe(head);
    expect(await resolveCommit(root, "HEAD")).toBe(head);
    expect(await resolveCommit(root, head)).toBe(head.toLowerCase());
    expect(await resolveCommit(root, "no-such-ref")).toBeUndefined();
  });

  it("does not follow a moved branch: SHAs stay exact after the branch advances", async () => {
    const root = await gitRepo();
    const before = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    await fs.writeFile(path.join(root, "file.txt"), "v2\n");
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "two"], { cwd: root });
    const after = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    expect(after).not.toBe(before);
    // A previously resolved SHA still names the exact original commit.
    expect(await resolveCommit(root, before)).toBe(before.toLowerCase());
    expect(await resolveCommit(root, "main")).toBe(after);
  });

  it("builds workspace create commands with a SHA-pinned base", async () => {
    const root = await gitRepo();
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const config = { version: 1, project: { name: "base-ref-test" }, validation: { baseRef: "main" } } as HarnessProjectConfig;
    const record = { id: "OP-BASE-REF", kind: "change" } as never;
    const built = await buildBranchOffWorkspaceCommand(root, record, config, { title: "t", branch: "aeh/op-test", slug: "slug" });
    expect(built.pinned).toBe(true);
    expect(built.base).toBe(head);
    expect(built.command).toContain(`--base '${head}'`);
    // Unresolvable bases fall back to the configured name (traced).
    const traced: string[] = [];
    const fallback = await buildBranchOffWorkspaceCommand(
      root, record, { version: 1, project: { name: "x" }, validation: { baseRef: "no-such-ref" } } as HarnessProjectConfig,
      { title: "t", branch: "aeh/op-test", slug: "slug" },
      async (event) => { traced.push(event); },
    );
    expect(fallback.pinned).toBe(false);
    expect(fallback.base).toBe("no-such-ref");
    expect(traced).toContain("workspace.base.unresolved");
  });
});
