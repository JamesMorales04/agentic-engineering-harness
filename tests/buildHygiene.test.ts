import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(".");

describe("repository build hygiene", () => {
  it("cleans dist before every build and rebuilds/links the repo-local CLI on npm prepare", async () => {
    const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")) as { bin: Record<string, string>; files: string[]; scripts: Record<string, string> };
    expect(pkg.scripts.clean).toContain("rmSync('dist'");
    expect(pkg.scripts.build).toBe("npm run clean && tsc -p tsconfig.json");
    expect(pkg.scripts.prepare).toBe("npm run build && node scripts/link-self-bin.mjs");
    expect(pkg.scripts.aeh).toBe("node ./dist/main.js");
    expect(pkg.files).toContain("scripts/link-self-bin.mjs");
    expect(pkg.bin.aeh).toBe("./dist/main.js");
  });

  it("ignores Harness runtime state by default and allowlists repository-owned configuration", async () => {
    const gitignore = await fs.readFile(path.join(root, ".gitignore"), "utf8");
    expect(gitignore).toContain(".harness/*");
    expect(gitignore).toContain("!.harness/project.yaml");
    expect(gitignore).toContain("!.harness/toolchain.yaml");
    expect(gitignore).toContain("!.harness/agents.source.jsonc");
    expect(gitignore).toContain("!.harness/otel-collector.yaml");
    expect(gitignore).not.toContain(".harness/runs/");
  });
});
