import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  findScopeDirectoryPatternWarnings,
  formatScopeDirectoryPatternWarning,
} from "../src/architecture/workGraph.js";
import { validateDiffScope } from "../src/validators/diffScope.js";
import type { TaskContract } from "../src/core/types.js";

async function makeRoot(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-scope-dir-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content);
  }
  await fs.mkdir(path.join(root, "src", "existing-dir"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "existing-dir", "a.ts"), "export const a = 1;\n");
  await fs.writeFile(path.join(root, "src", "exact.ts"), "export const x = 1;\n");
  return root;
}

describe("scope directory-pattern warning (fail-closed, warn-only)", () => {
  it("warns for an existing directory without glob magic, advising <dir>/**", async () => {
    const root = await makeRoot({});
    const warnings = await findScopeDirectoryPatternWarnings(root, ["src/existing-dir"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ normalized: "src/existing-dir", suggested: "src/existing-dir/**" });
    expect(formatScopeDirectoryPatternWarning(warnings[0]!)).toContain("src/existing-dir/**");
    expect(formatScopeDirectoryPatternWarning(warnings[0]!)).toContain("ZERO files");
  });

  it("warns for trailing-slash directory form", async () => {
    const root = await makeRoot({});
    const warnings = await findScopeDirectoryPatternWarnings(root, ["src/existing-dir/"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.suggested).toBe("src/existing-dir/**");
  });

  it("does NOT warn for explicit <dir>/**, bare **, exact files, or globs", async () => {
    const root = await makeRoot({});
    expect(await findScopeDirectoryPatternWarnings(root, ["src/existing-dir/**"])).toHaveLength(0);
    expect(await findScopeDirectoryPatternWarnings(root, ["**"])).toHaveLength(0);
    expect(await findScopeDirectoryPatternWarnings(root, ["src/exact.ts"])).toHaveLength(0);
    expect(await findScopeDirectoryPatternWarnings(root, ["src/*.ts"])).toHaveLength(0);
    expect(await findScopeDirectoryPatternWarnings(root, ["src/existing-dir/*"])).toHaveLength(0);
  });

  it("does NOT warn for new-file patterns (missing, not an existing dir)", async () => {
    const root = await makeRoot({});
    expect(await findScopeDirectoryPatternWarnings(root, ["src/brand-new-file-xyz.ts"])).toHaveLength(0);
    expect(await findScopeDirectoryPatternWarnings(root, ["src/nope/nested/new.ts"])).toHaveLength(0);
  });

  it("does NOT warn for unsafe/out-of-root inputs (fail-closed elsewhere, no expansion advice)", async () => {
    const root = await makeRoot({});
    expect(await findScopeDirectoryPatternWarnings(root, ["../outside/**"])).toHaveLength(0);
    expect(await findScopeDirectoryPatternWarnings(root, ["/etc/passwd"])).toHaveLength(0);
    expect(await findScopeDirectoryPatternWarnings(root, ["src/../outside"])).toHaveLength(0);
  });

  it("preserves fail-closed matching semantics (warn only, never broadens)", async () => {
    const contract: TaskContract = {
      version: 1,
      task: { id: "DIR-WARN", title: "dir warn" },
      scope: { allowed: ["src/existing-dir"], forbidden: [], frozen: [] },
    };
    const checks = validateDiffScope(["src/existing-dir/a.ts"], contract);
    // Bare directory still matches ZERO files: fail-closed narrowing preserved.
    expect(checks.find((c) => c.id === "diff.allowed-scope")?.status).toBe("FAIL");
    const open: TaskContract = {
      version: 1,
      task: { id: "DIR-WARN", title: "dir warn" },
      scope: { allowed: ["src/existing-dir/**"], forbidden: [], frozen: [] },
    };
    expect(
      validateDiffScope(["src/existing-dir/a.ts"], open).find((c) => c.id === "diff.allowed-scope")?.status,
    ).toBe("PASS");
  });
});
