import { mkdtemp, mkdir, symlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPermissionStopDiagnostic } from "../src/paseo/permissionDiagnostic.js";

const temporaryRoots: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "aeh permission root "));
  temporaryRoots.push(dir);
  return dir;
}
afterEach(async () => { await Promise.all(temporaryRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe("frozen permission scope classification", () => {
  it("classifies the exact authorized root and contained paths as INSIDE", async () => {
    const root = await tempDir();
    expect(await createPermissionStopDiagnostic("external_directory", [root], [root], "s")).toMatchObject({ scopeRelation: "INSIDE" });
    expect(await createPermissionStopDiagnostic("external_directory", [`${root}/child/*`], [root], "s")).toMatchObject({ scopeRelation: "INSIDE" });
  });

  it("classifies sibling worktree pools, /tmp, and ~/.local scopes as OUTSIDE", async () => {
    const root = path.join(await tempDir(), "worktrees", "current");
    await mkdir(root, { recursive: true });
    const siblingPool = path.dirname(root);
    const homeLocal = path.join(os.homedir(), ".local", "*");
    const diagnostics = await Promise.all([
      createPermissionStopDiagnostic("external_directory", [`${siblingPool}/*`], [root]),
      createPermissionStopDiagnostic("external_directory", [path.join(os.tmpdir(), "*")], [root]),
      createPermissionStopDiagnostic("external_directory", [homeLocal], [root])
    ]);
    expect(diagnostics.map((item) => item?.scopeRelation)).toEqual(["OUTSIDE", "OUTSIDE", "OUTSIDE"]);
  });

  it("uses path boundaries, preserves spaces, and resolves symlink targets", async () => {
    const parent = await tempDir();
    const root = path.join(parent, "repo with spaces");
    const elsewhere = path.join(parent, "repo sibling");
    await mkdir(root);
    await mkdir(elsewhere);
    const alias = path.join(parent, "repo alias");
    await symlink(root, alias, "dir");
    expect(await createPermissionStopDiagnostic("external_directory", [alias], [root])).toMatchObject({ scopeRelation: "INSIDE" });
    expect(await createPermissionStopDiagnostic("external_directory", [`${root}2/*`], [root])).toMatchObject({ scopeRelation: "OUTSIDE" });
    expect(await createPermissionStopDiagnostic("external_directory", [elsewhere], [root])).toMatchObject({ scopeRelation: "OUTSIDE" });
  });

  it("returns UNKNOWN for ambiguous parent globs and relative requests", async () => {
    const root = await tempDir();
    expect(await createPermissionStopDiagnostic("external_directory", ["/tmp/*"], ["/tmp"])).toMatchObject({ scopeRelation: "INSIDE" });
    expect(await createPermissionStopDiagnostic("external_directory", ["relative/*"], [root])).toMatchObject({ scopeRelation: "UNKNOWN" });
  });
});
