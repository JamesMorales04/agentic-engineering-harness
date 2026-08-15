import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import versions from "../templates/provider-versions.json";

const root = path.resolve(process.cwd());

describe("provider version contract", () => {
  it("keeps the initialized and source toolchains aligned with the authoritative provider versions", async () => {
    const expected = versions as Record<string, string>;
    const packageJson = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")) as { devDependencies?: Record<string, string> };
    const template = YAML.parse(await fs.readFile(path.join(root, "templates/toolchain.yaml"), "utf8")) as any;
    const initialized = YAML.parse(await fs.readFile(path.join(root, ".harness/toolchain.yaml"), "utf8")) as any;
    expect(template.tools.graphify.version).toBe(expected.graphify);
    expect(template.tools.serena.version).toBe(expected.serena);
    expect(template.tools.headroom.version).toBe(expected.headroom);
    expect(template.tools.engram.version).toBe(expected.engram);
    expect(template.tools.trivy.version).toBe(expected.trivy);
    expect(template.tools.opengrep.version).toBe(expected.opengrep);
    expect(template.tools.pnpm.version).toBe(expected.pnpm);
    expect(initialized.tools.graphify.version).toBe(expected.graphify);
    expect(initialized.tools.engram.version).toBe(expected.engram);
    expect(initialized.tools.trivy.version).toBe(expected.trivy);
    expect(initialized.tools.opengrep.version).toBe(expected.opengrep);
    expect(packageJson.devDependencies?.["@playwright/test"]).toBe(expected.playwright);
  });

  it("makes provider-contract CI consume the same source instead of duplicating pins", async () => {
    const workflow = await fs.readFile(path.join(root, ".github/workflows/ci.yml"), "utf8");
    expect(workflow).toContain("templates/provider-versions.json");
    expect(workflow).not.toContain("aquasecurity/trivy-action@");
    for (const version of ["0.28.0", "0.9.43", "0.4.1", "1.6.1", "0.70.0", "1.22.0", "1.62.1"]) expect(workflow).not.toContain(version);
  });
});
