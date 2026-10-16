import { describe, expect, it } from "vitest";
import { isManagedProvisionedPath, providerGeneratedPathspecExcludes } from "../src/core/git.js";

/**
 * D22: toolchain/provider droppings (`.serena`, `graphify-out`,
 * `.config/mise`) are exclude-from-accounting machine state — never
 * worker-attributable, never deliverable, NOT authorizable. This is distinct
 * from the D8 protected-manifest class (`.harness/managed-assets.json`,
 * seals, contracts: hard-deny, Owner-exemptible), which must NOT be covered
 * here.
 */
describe("isManagedProvisionedPath (D22)", () => {
  it("covers provider scratch and toolchain-provisioned state", () => {
    for (const file of [
      ".serena",
      ".serena/project.yml",
      "graphify-out",
      "graphify-out/cache/stat-index.json",
      ".config/mise",
      ".config/mise/conf.d/aeh.toml",
      ".config/mise/mise.lock",
      ".config/mise/locks/npm-pnpm/10.15.0/package.json",
    ]) {
      expect(isManagedProvisionedPath(file)).toBe(true);
    }
  });

  it("normalizes leading ./ and backslash separators", () => {
    expect(isManagedProvisionedPath("./.config/mise/mise.lock")).toBe(true);
    expect(isManagedProvisionedPath(".config\\mise\\mise.lock")).toBe(true);
    expect(isManagedProvisionedPath("./graphify-out/cache/stat-index.json")).toBe(true);
  });

  it("never covers product source or the D8 protected-manifest class", () => {
    for (const file of [
      "src/tasks.js",
      ".config",
      ".config/other/tool.json",
      ".config/mise-something/x",
      "aconfig/mise",
      "mise",
      "graphify-outside/x",
      "xgraphify-out/y",
      ".harness/managed-assets.json",
      ".harness/seals/T-1.json",
      ".harness/contracts/T-1.yaml",
    ]) {
      expect(isManagedProvisionedPath(file)).toBe(false);
    }
  });
});

describe("providerGeneratedPathspecExcludes (D22: .config/mise joins the set)", () => {
  it("excludes every managed-provisioned prefix", () => {
    const excludes = providerGeneratedPathspecExcludes();
    for (const prefix of [".serena", "graphify-out", ".config/mise"]) {
      expect(excludes).toContain(`:(exclude)${prefix}`);
      expect(excludes).toContain(`:(exclude)${prefix}/**`);
    }
  });
});
